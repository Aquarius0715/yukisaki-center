"""Deterministic route aggregation and public response construction."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from dataclasses import replace
from datetime import timedelta
from typing import Any

from .config import (
    COMPARISON_OVERLAP_LIMITS,
    COST_CONFIG_VERSION,
    MAX_CANDIDATES,
    MAX_SNAP_DISTANCE_M,
    SIMILARITY_THRESHOLD,
)
from .models import RouteRequest
from .repository import GraphUnavailableError, RoutingRepository


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

    def plan(self, payload: Any) -> dict[str, Any]:
        request = RouteRequest.parse(payload)
        if request.mode == "comparison":
            return self._plan_comparison(payload, request)
        result, diverse, versions = self._plan_mode(request)
        _labels(diverse, request.mode)
        return self._response(payload, request, result, diverse, versions)

    def _plan_mode(
        self,
        request: RouteRequest,
        *,
        comparison_pool: bool = False,
    ) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]:
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
        planned = {
            mode: self._plan_mode(replace(request, mode=mode), comparison_pool=True)
            for mode in ("balanced", "drivability_priority", "distance_priority")
        }
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

        response = self._response(payload, request, balanced_result, selected, versions)
        response["recommended_route_id"] = recommended_route_id or selected[0]["route_id"]
        return response

    @staticmethod
    def _response(
        payload: Any,
        request: RouteRequest,
        result: dict[str, Any],
        diverse: list[dict[str, Any]],
        versions: dict[str, str],
    ) -> dict[str, Any]:
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
