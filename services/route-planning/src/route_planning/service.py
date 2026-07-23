"""Deterministic route aggregation and public response construction."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from datetime import timedelta
from typing import Any

from .config import (
    COST_CONFIG_VERSION,
    MAX_CANDIDATES,
    MAX_SNAP_DISTANCE_M,
    SIMILARITY_THRESHOLD,
)
from .models import RouteRequest
from .repository import RoutingRepository


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
    for edge in edges:
        factors.update((edge["factors"] or {}).keys())
        if float(edge["max_slope_percent"] or 0) >= 8:
            factors.add("steep_slope")
        if edge["bridge"]:
            factors.add("bridge")
    return {
        "segment_ids": [edge["segment_id"] for edge in edges],
        "minimum_drivability_score": min(scores) if scores else None,
        "factors": sorted(factors),
        "geometry": {"type": "LineString", "coordinates": _coordinates(edges)},
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
    }


def _overlap(first: dict[str, Any], second: dict[str, Any]) -> float:
    left, right = set(first["segment_ids"]), set(second["segment_ids"])
    return len(left & right) / max(1, min(len(left), len(right)))


def _labels(routes: list[dict[str, Any]], mode: str) -> None:
    if not routes:
        return
    selected_label = {
        "time_priority": "fastest",
        "balanced": "balanced",
        "drivability_priority": "most_drivable",
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


class RoutePlanningService:
    def __init__(self, repository: RoutingRepository | None = None):
        self.repository = repository or RoutingRepository()

    def plan(self, payload: Any) -> dict[str, Any]:
        request = RouteRequest.parse(payload)
        result = self.repository.plan(request, MAX_SNAP_DISTANCE_M)
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
        diverse: list[dict[str, Any]] = []
        fastest_duration = min(route["duration_s"] for route in candidates)
        for route in candidates:
            if route["duration_s"] > fastest_duration + request.options.max_detour_minutes * 60:
                continue
            if any(_overlap(route, selected) >= SIMILARITY_THRESHOLD for selected in diverse):
                continue
            diverse.append(route)
            if len(diverse) == MAX_CANDIDATES:
                break
        if not diverse:
            diverse = [candidates[0]]
        _labels(diverse, request.mode)
        for rank, route in enumerate(diverse, start=1):
            route["rank"] = rank
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
            "warnings": warnings,
        }
