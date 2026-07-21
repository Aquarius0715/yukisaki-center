"""Deterministic MVP rules for a road-segment drivability score."""

from __future__ import annotations

from datetime import datetime
from typing import Any

RULE_VERSION = "mvp-2026-01-23-v1"


def score_segment(segment: dict[str, Any]) -> dict[str, Any]:
    data_timestamp = datetime.fromisoformat(segment["data_timestamp"])
    if data_timestamp.tzinfo is None:
        raise ValueError("data_timestamp must include a timezone")
    snowfall = float(segment.get("snowfall_1h_cm") or 0)
    slope = float(segment.get("max_slope_percent") or 0)
    temperature = segment.get("temperature_c")
    factors: dict[str, int] = {}
    if snowfall >= 5:
        factors["heavy_hourly_snowfall"] = -25
    elif snowfall >= 2:
        factors["moderate_hourly_snowfall"] = -15
    elif snowfall > 0:
        factors["light_hourly_snowfall"] = -5
    if slope >= 8:
        factors["steep_slope"] = -20
    elif slope >= 5:
        factors["moderate_slope"] = -10
    last_plowed_at = segment.get("last_plowed_at")
    if last_plowed_at:
        last_plowed = datetime.fromisoformat(last_plowed_at)
        elapsed_minutes = max(0, (data_timestamp - last_plowed).total_seconds() / 60)
        if elapsed_minutes <= 60:
            factors["plowed_within_60_minutes"] = 10
        elif elapsed_minutes < 180:
            factors["plowed_60_to_180_minutes_ago"] = -8
        else:
            factors["plowed_over_180_minutes_ago"] = -15
    else:
        factors["no_plow_history"] = -15
    if segment.get("snow_pipe") is True and segment.get("snow_pipe_operation_status") == "active":
        factors["active_snow_pipe"] = 15
    if temperature is not None and -3 <= float(temperature) <= 1 and snowfall > 0:
        factors["freezing_wet_condition"] = -20
    score = max(0, min(100, 100 + sum(factors.values())))
    known_fields = (
        "snowfall_1h_cm", "max_slope_percent", "last_plowed_at",
        "snow_pipe", "temperature_c",
    )
    known = sum(segment.get(key) is not None for key in known_fields)
    return {
        "segment_id": segment["segment_id"],
        "score": score,
        "confidence": round(known / len(known_fields), 2),
        "factors": factors,
        "inputs": {key: segment.get(key) for key in known_fields},
        "data_timestamp": segment["data_timestamp"],
        "rule_version": RULE_VERSION,
        "is_simulated": bool(segment.get("is_simulated", False)),
    }
