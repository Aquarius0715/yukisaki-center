"""Predictive departure-time recommendation.

This module estimates the probability that a route's least-recently-plowed
segments will be freshly plowed by a candidate future departure time,
trained on historical `snowplow_segment_passages` headways. It is an
additive, clearly-labelled statistical layer for route-search UX only: it
never feeds back into `drivability_score`, route cost, or ranking, which
stay rule-based (see AGENTS.md).

Model inputs are pinned to the fixed demo `reference_time`, so the "current"
elapsed-since-last-pass values only ever see passages already known as of
that instant. The pooled training samples, by contrast, are drawn from the
full available passage history network-wide (see
`RoutingRepository.fetch_training_passage_samples`) so the model can learn
typical plow cadence even when a specific route's segments have too little
history of their own.
"""

from __future__ import annotations

import bisect
import math
import random
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from .config import (
    DEPARTURE_CANDIDATE_OFFSETS_MINUTES,
    DEPARTURE_FRESH_WINDOW_MINUTES,
    DEPARTURE_MAX_TRAINING_SAMPLES,
    DEPARTURE_MODEL_VERSION,
    DEPARTURE_NO_HISTORY_ELAPSED_MINUTES,
    DEPARTURE_PROBABILITY_THRESHOLD,
    DEPARTURE_SAMPLE_STEP_MINUTES,
)

BASIS_TEXT = (
    "logistic regression trained on historical snowplow_segment_passages headways; "
    "predicts the probability that this route's least-recently plowed segments will "
    "be freshly plowed by a given departure time. Does not affect drivability_score, "
    "route cost, or ranking."
)


def _sigmoid(z: float) -> float:
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    ez = math.exp(z)
    return ez / (1.0 + ez)


def _standardize(values: list[float]) -> tuple[float, float]:
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    return mean, math.sqrt(variance) or 1.0


@dataclass(frozen=True)
class LogisticModel:
    weights: tuple[float, float, float]
    means: tuple[float, float]
    scales: tuple[float, float]
    # Largest elapsed-since-last-pass value actually seen in training. A
    # linear model extrapolates arbitrarily (and can saturate toward either
    # 0 or 1 for reasons unrelated to the real world) once fed an input far
    # outside the range it was fit on, so callers must not trust predict()
    # for elapsed_minutes beyond this bound -- see covers().
    max_observed_elapsed_minutes: float

    def predict(self, elapsed_minutes: float, horizon_minutes: float) -> float:
        bias, w1, w2 = self.weights
        x1 = (elapsed_minutes - self.means[0]) / self.scales[0]
        x2 = (horizon_minutes - self.means[1]) / self.scales[1]
        return _sigmoid(bias + w1 * x1 + w2 * x2)

    def covers(self, elapsed_minutes: float) -> bool:
        return elapsed_minutes <= self.max_observed_elapsed_minutes


def fit_logistic_regression(
    features: list[tuple[float, float]],
    labels: list[int],
    *,
    iterations: int = 200,
    learning_rate: float = 0.5,
    l2: float = 0.01,
) -> LogisticModel:
    if not features or len(features) != len(labels):
        raise ValueError("features and labels must be non-empty and equal length")
    elapsed_mean, elapsed_scale = _standardize([f[0] for f in features])
    horizon_mean, horizon_scale = _standardize([f[1] for f in features])
    rows = [
        (1.0, (e - elapsed_mean) / elapsed_scale, (h - horizon_mean) / horizon_scale)
        for e, h in features
    ]
    weights = [0.0, 0.0, 0.0]
    n = len(rows)
    for _ in range(iterations):
        gradients = [0.0, 0.0, 0.0]
        for row, label in zip(rows, labels):
            error = _sigmoid(sum(w * v for w, v in zip(weights, row))) - label
            for index, value in enumerate(row):
                gradients[index] += error * value
        weights = [
            w - learning_rate * (gradients[i] / n + (l2 * w if i > 0 else 0.0))
            for i, w in enumerate(weights)
        ]
    return LogisticModel(
        weights=(weights[0], weights[1], weights[2]),
        means=(elapsed_mean, horizon_mean),
        scales=(elapsed_scale, horizon_scale),
        max_observed_elapsed_minutes=max(f[0] for f in features),
    )


def _minutes_since_last(sorted_times: list[datetime], at: datetime) -> float | None:
    index = bisect.bisect_right(sorted_times, at) - 1
    if index < 0:
        return None
    return (at - sorted_times[index]).total_seconds() / 60.0


def build_training_samples(
    passages_by_segment: dict[str, list[datetime]],
) -> tuple[list[tuple[float, float]], list[int]]:
    """Turn observed passage timelines into (elapsed_now, horizon) -> label samples.

    For each historical instant sampled along a segment's timeline, the label
    records whether the segment was within the fresh-plow window `horizon`
    minutes later. Everything here is derived from already-observed
    passages, so no sample looks further ahead than data that has already
    happened by the time it is used.
    """
    features: list[tuple[float, float]] = []
    labels: list[int] = []
    step = timedelta(minutes=DEPARTURE_SAMPLE_STEP_MINUTES)
    for times in passages_by_segment.values():
        ordered = sorted(times)
        if len(ordered) < 2:
            continue
        cursor = ordered[0]
        end = ordered[-1]
        while cursor < end:
            elapsed_now = _minutes_since_last(ordered, cursor)
            if elapsed_now is not None:
                for offset in DEPARTURE_CANDIDATE_OFFSETS_MINUTES:
                    future = cursor + timedelta(minutes=offset)
                    elapsed_future = _minutes_since_last(ordered, future)
                    label = 1 if (
                        elapsed_future is not None and elapsed_future <= DEPARTURE_FRESH_WINDOW_MINUTES
                    ) else 0
                    features.append((elapsed_now, float(offset)))
                    labels.append(label)
            cursor += step
    if len(features) > DEPARTURE_MAX_TRAINING_SAMPLES:
        indices = random.sample(range(len(features)), DEPARTURE_MAX_TRAINING_SAMPLES)
        features = [features[i] for i in indices]
        labels = [labels[i] for i in indices]
    return features, labels


def weak_segment_ids(path: list[dict[str, Any]], reference_time: datetime) -> list[str]:
    """Segments on the route not already within the fresh-plow window."""
    threshold = reference_time - timedelta(minutes=DEPARTURE_FRESH_WINDOW_MINUTES)
    weak: list[str] = []
    seen: set[str] = set()
    for edge in path:
        segment_id = edge["segment_id"]
        if segment_id in seen:
            continue
        seen.add(segment_id)
        observed_at = edge.get("observed_at")
        if observed_at is None or observed_at < threshold:
            weak.append(segment_id)
    return weak


def _elapsed_minutes_for_prediction(last_observed: datetime | None, reference_time: datetime) -> float:
    if last_observed is None:
        return DEPARTURE_NO_HISTORY_ELAPSED_MINUTES
    return max(0.0, (reference_time - last_observed).total_seconds() / 60.0)


def no_wait_needed_response(reference_time: datetime) -> dict[str, Any]:
    return {
        "model_version": DEPARTURE_MODEL_VERSION,
        "is_prediction": True,
        "is_simulated": True,
        "basis": "every route segment was already within the 60-minute freshly-plowed window as of reference_time",
        "evaluated_segment_ids": [],
        "recommended_offset_minutes": 0,
        "recommended_departure_time": reference_time.isoformat(),
        "meets_probability_threshold": True,
        "candidates": [],
        "insufficient_data": False,
    }


def insufficient_data_response(reference_time: datetime, evaluated_segment_ids: list[str]) -> dict[str, Any]:
    return {
        "model_version": DEPARTURE_MODEL_VERSION,
        "is_prediction": True,
        "is_simulated": True,
        "basis": "insufficient historical snowplow passage data to train a departure-time prediction",
        "evaluated_segment_ids": sorted(evaluated_segment_ids),
        "recommended_offset_minutes": 0,
        "recommended_departure_time": reference_time.isoformat(),
        "meets_probability_threshold": False,
        "candidates": [],
        "insufficient_data": True,
    }


def recommend_departure(
    model: LogisticModel,
    evaluated_segment_ids: list[str],
    latest_passages: dict[str, datetime],
    reference_time: datetime,
) -> dict[str, Any]:
    elapsed_by_segment = {
        segment_id: _elapsed_minutes_for_prediction(latest_passages.get(segment_id), reference_time)
        for segment_id in evaluated_segment_ids
    }
    if any(not model.covers(elapsed) for elapsed in elapsed_by_segment.values()):
        # At least one segment's current elapsed-since-last-pass falls
        # outside anything the pooled training data actually observed.
        # Extrapolating the fitted line that far is not a real estimate, so
        # be honest about the gap instead of reporting a number.
        return insufficient_data_response(reference_time, evaluated_segment_ids)
    candidates = []
    for offset in DEPARTURE_CANDIDATE_OFFSETS_MINUTES:
        probabilities = [
            model.predict(elapsed_by_segment[segment_id], float(offset))
            for segment_id in evaluated_segment_ids
        ]
        candidates.append({
            "offset_minutes": offset,
            "departure_time": (reference_time + timedelta(minutes=offset)).isoformat(),
            "minimum_plow_probability": round(min(probabilities), 3),
            "average_plow_probability": round(sum(probabilities) / len(probabilities), 3),
        })
    best = next(
        (c for c in candidates if c["minimum_plow_probability"] >= DEPARTURE_PROBABILITY_THRESHOLD),
        max(candidates, key=lambda c: c["minimum_plow_probability"]),
    )
    return {
        "model_version": DEPARTURE_MODEL_VERSION,
        "is_prediction": True,
        "is_simulated": True,
        "basis": BASIS_TEXT,
        "evaluated_segment_ids": sorted(evaluated_segment_ids),
        "recommended_offset_minutes": best["offset_minutes"],
        "recommended_departure_time": best["departure_time"],
        "meets_probability_threshold": best["minimum_plow_probability"] >= DEPARTURE_PROBABILITY_THRESHOLD,
        "candidates": candidates,
        "insufficient_data": False,
    }
