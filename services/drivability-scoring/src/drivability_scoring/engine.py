"""Deterministic rules for a road-segment drivability score."""

from __future__ import annotations

from typing import Any


def score_segment(segment: dict[str, Any]) -> dict[str, Any]:
    snow_depth = float(segment.get("snow_depth_cm", 0))
    slope = float(segment.get("max_slope_percent", 0))
    plowed = bool(segment.get("plowed", False))
    sprinkling = bool(segment.get("snow_melting", False))
    penalties = {
        "snow_depth": min(round(snow_depth * 2), 40),
        "slope": min(round(slope * 2), 25),
        "not_plowed": 0 if plowed else 20,
        "no_snow_melting": 0 if sprinkling else 5,
    }
    score = max(0, min(100, 100 - sum(penalties.values())))
    known = sum(key in segment for key in ("snow_depth_cm", "max_slope_percent", "plowed"))
    return {
        "segment_id": segment["segment_id"],
        "score": score,
        "confidence": round(known / 3, 2),
        "factors": penalties,
        "data_timestamp": segment["data_timestamp"],
        "rule_version": "demo-1.0.0",
        "is_simulated": bool(segment.get("is_simulated", False)),
    }
