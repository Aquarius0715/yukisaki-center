"""Deterministic route aggregation and public response construction."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta
from typing import Any

from . import departure_advisor
from .config import (
    COMPARISON_OVERLAP_LIMITS,
    COST_CONFIG_VERSION,
    DEPARTURE_MIN_TRAINING_SAMPLES,
    DEPARTURE_MODEL_CACHE_TTL_SECONDS,
    DEPARTURE_TRAINING_SEGMENT_LIMIT,
    MAX_CANDIDATES,
    MAX_SNAP_DISTANCE_M,
    ROUTE_RESULT_CACHE_TTL_SECONDS,
    SIMILARITY_THRESHOLD,
)
from .models import RouteRequest
from .repository import GraphUnavailableError, RoutingRepository

LOGGER = logging.getLogger(__name__)


def _path_groups(rows: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[int(row["path_id"])].append(row)
    return [grouped[path_id] for path_id in sorted(grouped)]


def _coordinates(path: list[dict[str, Any]]) -> list[list[float]]:
    result: list[list[float]] = []
    for edge in path:
        coordinates = edge["st_asgeojson"]["coordinates"]
        if int(edge["node"]) == int(edge["target"]):
            coordinates = list(reversed(coordinates))
        for point in coordinates:
            normalized = [float(point[0]), float(point[1])]
            if not result or result[-1] != normalized:
                result.append(normalized)
    return result


def _hazard_groups(path: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    for edge in path:
        hazardous = (
            edge["score"] is not None and int(edge["score"]) < 40
        ) or float(edge["max_slope_percent"] or 0) >= 8 or bool(edge["bridge"])
        if hazardous:
            current.append(edge)
        elif current:
            groups.append(_hazard(current))
            current = []
    if current:
        groups.append(_hazard(current))
    return groups


def _hazard(edges: list[dict[str, Any]]) -> dict[str, Any]:
    scores = [int(edge["score"]) for edge in edges if edge["score"] is not None]
    factors: set[str] = set()
    road_name: str | None = None
    max_slope_percent = 0.0
    snowfall_1h_cm: float | None = None
    temperature_c: float | None = None
    oldest_plowed_at = None
    missing_plow_history = False
    for edge in edges:
        applied_rules = (edge["factors"] or {}).get("applied_rules") or {}
        factors.update(applied_rules.keys())
        inputs = (edge["factors"] or {}).get("inputs") or {}
        if road_name is None and edge.get("road_name"):
            road_name = str(edge["road_name"])
        slope = float(edge["max_slope_percent"] or 0)
        max_slope_percent = max(max_slope_percent, slope)
        if slope >= 8:
            factors.add("steep_slope")
        if edge["bridge"]:
            factors.add("bridge")
        if snowfall_1h_cm is None and inputs.get("snowfall_1h_cm") is not None:
            snowfall_1h_cm = float(inputs["snowfall_1h_cm"])
        if temperature_c is None and inputs.get("temperature_c") is not None:
            temperature_c = float(inputs["temperature_c"])
        if edge["observed_at"] is None:
            missing_plow_history = True
        elif oldest_plowed_at is None or edge["observed_at"] < oldest_plowed_at:
            oldest_plowed_at = edge["observed_at"]
    # Passing only rule names (e.g. "steep_slope") gives the AI nothing to tell
    # two similarly-classified hazards apart, so it produces near-identical text.
    # Concrete evidence values let it ground each explanation in specifics.
    evidence: dict[str, Any] = {
        "length_m": round(sum(float(edge["length_m"]) for edge in edges), 1),
    }
    if road_name:
        evidence["road_name"] = road_name
    if max_slope_percent:
        evidence["max_slope_percent"] = round(max_slope_percent, 1)
    if snowfall_1h_cm is not None:
        evidence["snowfall_1h_cm"] = snowfall_1h_cm
    if temperature_c is not None:
        evidence["temperature_c"] = temperature_c
    if oldest_plowed_at is not None and not missing_plow_history:
        evidence["last_plowed_at"] = oldest_plowed_at.isoformat()
    return {
        "segment_ids": [edge["segment_id"] for edge in edges],
        "minimum_drivability_score": min(scores) if scores else None,
        "factors": sorted(factors),
        "geometry": {"type": "LineString", "coordinates": _coordinates(edges)},
        "evidence": evidence,
    }


def _aggregate(path: list[dict[str, Any]], request: RouteRequest, versions: dict[str, str]) -> dict[str, Any]:
    distance = sum(float(edge["length_m"]) for edge in path)
    duration = sum(float(edge["base_travel_time_s"]) for edge in path)
    weighted_cost = sum(float(edge["cost"]) for edge in path)
    scored = [edge for edge in path if edge["score"] is not None]
    scored_distance = sum(float(edge["length_m"]) for edge in scored)
    average_score = (
        sum(float(edge["score"]) * float(edge["length_m"]) for edge in scored) / scored_distance
        if scored_distance else None
    )
    scores = [int(edge["score"]) for edge in scored]
    confidences = [float(edge["confidence"]) for edge in scored if edge["confidence"] is not None]
    recent_threshold = request.reference_time - timedelta(minutes=60)
    plowed_distance = sum(
        float(edge["length_m"]) for edge in path
        if edge["observed_at"] is not None and edge["observed_at"] >= recent_threshold
    )
    pipe_distance = sum(
        float(edge["length_m"]) for edge in path
        if edge["snow_pipe"] is True and edge["operation_status"] == "active"
    )
    segment_ids = [edge["segment_id"] for edge in path]
    route_payload = {
        "request": {
            "origin": request.origin.__dict__, "destination": request.destination.__dict__,
            "mode": request.mode, "options": request.options.__dict__,
        },
        "versions": versions,
        "segments": segment_ids,
    }
    route_id = "route-" + hashlib.sha256(
        json.dumps(route_payload, sort_keys=True, default=list).encode()
    ).hexdigest()[:24]
    hazards = _hazard_groups(path)
    return {
        "route_id": route_id,
        "geometry": {"type": "LineString", "coordinates": _coordinates(path)},
        "segment_ids": segment_ids,
        "distance_m": round(distance, 1),
        "duration_s": round(duration),
        "weighted_cost_s": round(weighted_cost, 2),
        "average_drivability_score": round(average_score, 1) if average_score is not None else None,
        "minimum_drivability_score": min(scores) if scores else None,
        "score_coverage": round(scored_distance / distance, 4) if distance else 0,
        "minimum_confidence": round(min(confidences), 3) if confidences else None,
        "plowed_ratio": round(plowed_distance / distance, 4) if distance else 0,
        "snow_pipe_ratio": round(pipe_distance / distance, 4) if distance else 0,
        "hazard_group_count": len(hazards),
        "hazard_groups": hazards,
        "is_simulated": any(
            bool(edge["score_is_simulated"] or edge["edge_is_simulated"]) for edge in path
        ),
        # Internal only: consumed by the departure-time predictor, stripped
        # in _response before the route is serialized.
        "_path": path,
    }


def _overlap(first: dict[str, Any], second: dict[str, Any]) -> float:
    left, right = set(first["segment_ids"]), set(second["segment_ids"])
    return len(left & right) / max(1, min(len(left), len(right)))


def _select_candidates(
    candidates: list[dict[str, Any]],
    max_detour_minutes: int,
) -> list[dict[str, Any]]:
    """Prefer diverse routes, then fill remaining slots with distinct KSP paths."""
    eligible = _eligible_candidates(candidates, max_detour_minutes)
    selected: list[dict[str, Any]] = []
    for route in eligible:
        if any(_overlap(route, current) >= SIMILARITY_THRESHOLD for current in selected):
            continue
        selected.append(route)
        if len(selected) == MAX_CANDIDATES:
            return selected

    # A K-shortest candidate can be useful even when it differs only around
    # one junction. Backfill up to three without duplicating an identical path.
    selected_paths = {tuple(route["segment_ids"]) for route in selected}
    for route in eligible:
        path = tuple(route["segment_ids"])
        if path in selected_paths:
            continue
        selected.append(route)
        selected_paths.add(path)
        if len(selected) == MAX_CANDIDATES:
            break
    return selected


def _eligible_candidates(
    candidates: list[dict[str, Any]],
    max_detour_minutes: int,
) -> list[dict[str, Any]]:
    fastest_duration = min(route["duration_s"] for route in candidates)
    maximum_duration = fastest_duration + max_detour_minutes * 60
    eligible: list[dict[str, Any]] = []
    paths: set[tuple[str, ...]] = set()
    for route in candidates:
        path = tuple(route["segment_ids"])
        if route["duration_s"] > maximum_duration or path in paths:
            continue
        eligible.append(route)
        paths.add(path)
    return eligible


def _labels(routes: list[dict[str, Any]], mode: str) -> None:
    if not routes:
        return
    selected_label = {
        "time_priority": "fastest",
        "balanced": "balanced",
        "drivability_priority": "most_drivable",
        "distance_priority": "distance_priority",
    }[mode]
    for route in routes:
        route["label"] = "alternative"
    routes[0]["label"] = selected_label
    fastest = min(routes, key=lambda route: route["duration_s"])
    if fastest is not routes[0]:
        fastest["label"] = "fastest"
    drivable = max(
        routes,
        key=lambda route: (
            route["minimum_drivability_score"] if route["minimum_drivability_score"] is not None else -1,
            route["average_drivability_score"] if route["average_drivability_score"] is not None else -1,
        ),
    )
    if drivable is not routes[0] and drivable["label"] == "alternative":
        drivable["label"] = "most_drivable"


def _path_key(route: dict[str, Any]) -> tuple[str, ...]:
    return tuple(route["segment_ids"])


def _middle_path(route: dict[str, Any]) -> dict[str, Any]:
    segment_ids = route["segment_ids"]
    trim = max(1, round(len(segment_ids) * 0.1))
    middle = segment_ids[trim:-trim]
    return {"segment_ids": middle or segment_ids}


def _pick_profile_route(
    routes: list[dict[str, Any]],
    selected: list[dict[str, Any]],
) -> dict[str, Any] | None:
    selected_paths = {_path_key(route) for route in selected}
    for overall_limit, middle_limit in COMPARISON_OVERLAP_LIMITS:
        for route in routes:
            if _path_key(route) in selected_paths:
                continue
            if all(
                _overlap(route, current) <= overall_limit
                and _overlap(_middle_path(route), _middle_path(current)) <= middle_limit
                for current in selected
            ):
                return route
    return None


class RoutePlanningService:
    def __init__(self, repository: RoutingRepository | None = None):
        self.repository = repository or RoutingRepository()
        self._departure_model: departure_advisor.LogisticModel | None = None
        self._departure_model_trained_at: float = float("-inf")
        self._plan_cache: dict[RouteRequest, tuple[float, dict[str, Any]]] = {}

    def plan(self, payload: Any) -> dict[str, Any]:
        request = RouteRequest.parse(payload)
        if request.mode == "comparison":
            return self._plan_comparison(payload, request)
        result, diverse, versions = self._plan_mode(request)
        _labels(diverse, request.mode)
        departure_recommendation = self._departure_recommendation(diverse[0], request.reference_time)
        return self._response(payload, request, result, diverse, versions, departure_recommendation)

    def _get_departure_model(self) -> departure_advisor.LogisticModel | None:
        now = time.monotonic()
        if (
            self._departure_model is not None
            and now - self._departure_model_trained_at < DEPARTURE_MODEL_CACHE_TTL_SECONDS
        ):
            return self._departure_model
        passages = self.repository.fetch_training_passage_samples(DEPARTURE_TRAINING_SEGMENT_LIMIT)
        features, labels = departure_advisor.build_training_samples(passages)
        model = (
            departure_advisor.fit_logistic_regression(features, labels)
            if len(features) >= DEPARTURE_MIN_TRAINING_SAMPLES
            else None
        )
        LOGGER.info(
            "departure model trained pooled_segments=%d samples=%d model_trained=%s max_observed_elapsed=%s",
            len(passages), len(features), model is not None,
            getattr(model, "max_observed_elapsed_minutes", None),
        )
        self._departure_model = model
        self._departure_model_trained_at = now
        return model

    def _departure_recommendation(
        self,
        primary_route: dict[str, Any],
        reference_time: datetime,
    ) -> dict[str, Any]:
        path = primary_route["_path"]
        weak_ids = departure_advisor.weak_segment_ids(path, reference_time)
        if not weak_ids:
            return departure_advisor.no_wait_needed_response(reference_time)
        model = self._get_departure_model()
        if model is None:
            LOGGER.info("departure recommendation insufficient_data reason=no_model weak_segments=%d", len(weak_ids))
            return departure_advisor.insufficient_data_response(reference_time, weak_ids)
        latest_passages = self.repository.fetch_latest_passages(weak_ids, reference_time)
        elapsed_values = sorted({
            round((reference_time - latest_passages[segment_id]).total_seconds() / 60.0, 1)
            if segment_id in latest_passages else None
            for segment_id in weak_ids
        }, key=lambda value: (value is None, value))
        LOGGER.info(
            "departure recommendation weak_segments=%d matched_latest_passages=%d "
            "distinct_elapsed_values=%s model_max_observed_elapsed=%.1f",
            len(weak_ids), len(latest_passages), elapsed_values[:5], model.max_observed_elapsed_minutes,
        )
        return departure_advisor.recommend_departure(model, weak_ids, latest_passages, reference_time)

    def _cached_repository_plan(self, request: RouteRequest) -> dict[str, Any]:
        now = time.monotonic()
        cached = self._plan_cache.get(request)
        if cached is not None and now - cached[0] < ROUTE_RESULT_CACHE_TTL_SECONDS:
            return cached[1]
        result = self.repository.plan(request, MAX_SNAP_DISTANCE_M)
        self._plan_cache[request] = (now, result)
        return result

    def _plan_mode(
        self,
        request: RouteRequest,
        *,
        comparison_pool: bool = False,
    ) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]:
        result = self._cached_repository_plan(request)
        versions = {
            "graph_version": result["graph_version"],
            "score_rule_version": result["score_rule_version"],
            "cost_config_version": COST_CONFIG_VERSION,
        }
        candidates = [
            _aggregate(path, request, versions)
            for path in _path_groups(result["rows"])
        ]
        candidates.sort(key=lambda route: (route["weighted_cost_s"], route["duration_s"], route["route_id"]))
        if comparison_pool:
            return (
                result,
                _eligible_candidates(candidates, request.options.max_detour_minutes),
                versions,
            )
        diverse = _select_candidates(candidates, request.options.max_detour_minutes)
        if not diverse:
            diverse = [candidates[0]]
        return result, diverse, versions

    def _plan_comparison(self, payload: Any, request: RouteRequest) -> dict[str, Any]:
        # Run profiles concurrently: three sequential pgr_ksp/cost-cache
        # passes risk summing past the Lambda's 29s timeout, whereas running
        # them in parallel keeps wall-clock close to the slowest single
        # profile. Connection-storm risk is bounded instead by capping this
        # function's own Lambda concurrency (see environment.sh), which
        # limits worst-case simultaneous connections against the shared RDS
        # instance without penalizing every request's latency.
        modes = ("balanced", "drivability_priority", "distance_priority")
        with ThreadPoolExecutor(max_workers=len(modes)) as executor:
            futures = {
                mode: executor.submit(self._plan_mode, replace(request, mode=mode), comparison_pool=True)
                for mode in modes
            }
            planned = {mode: future.result() for mode, future in futures.items()}
        balanced_result, balanced_routes, versions = planned["balanced"]
        for mode, (result, _, profile_versions) in planned.items():
            if (
                profile_versions != versions
                or result["data_timestamp"] != balanced_result["data_timestamp"]
                or result["origin"]["node_id"] != balanced_result["origin"]["node_id"]
                or result["destination"]["node_id"] != balanced_result["destination"]["node_id"]
            ):
                raise GraphUnavailableError(
                    f"route comparison inputs changed during planning mode={mode}"
                )
        selected: list[dict[str, Any]] = []
        recommended_route_id: str | None = None
        profiles = (
            ("balanced", balanced_routes),
            ("most_drivable", planned["drivability_priority"][1]),
            ("distance_priority", planned["distance_priority"][1]),
        )
        for label, routes in profiles:
            route = routes[0] if not selected else _pick_profile_route(routes, selected)
            if route is None:
                continue
            route = dict(route)
            route["label"] = label
            selected.append(route)
            if label == "balanced":
                recommended_route_id = route["route_id"]

        departure_recommendation = self._departure_recommendation(selected[0], request.reference_time)
        response = self._response(payload, request, balanced_result, selected, versions, departure_recommendation)
        response["recommended_route_id"] = recommended_route_id or selected[0]["route_id"]
        return response

    @staticmethod
    def _response(
        payload: Any,
        request: RouteRequest,
        result: dict[str, Any],
        diverse: list[dict[str, Any]],
        versions: dict[str, str],
        departure_recommendation: dict[str, Any],
    ) -> dict[str, Any]:
        for rank, route in enumerate(diverse, start=1):
            route["rank"] = rank
            route.pop("_path", None)
        warnings = []
        if any(route["score_coverage"] < 1 for route in diverse):
            warnings.append("走りやすさ指数が未算出の区間を含みます")
        request_id = "route-request-" + hashlib.sha256(
            json.dumps(payload, sort_keys=True).encode()
        ).hexdigest()[:24]
        return {
            "request_id": request_id,
            "mode": request.mode,
            "reference_time": request.reference_time.isoformat(),
            **versions,
            "data_timestamp": result["data_timestamp"],
            "is_simulated": any(route["is_simulated"] for route in diverse),
            "snapped_points": {
                "origin": result["origin"], "destination": result["destination"],
            },
            "routes": diverse,
            "departure_recommendation": departure_recommendation,
            "warnings": warnings,
        }
