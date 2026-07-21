"""Build deterministic road routes and sample positions on them."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

EARTH_RADIUS_M = 6_371_000.0


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = a
    lon2, lat2 = b
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return math.hypot(x, y) * EARTH_RADIUS_M


def heading_degrees(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, a)
    lon2, lat2 = map(math.radians, b)
    value = math.degrees(math.atan2(
        math.sin(lon2 - lon1) * math.cos(lat2),
        math.cos(lat1) * math.sin(lat2)
        - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1),
    ))
    return (value + 360.0) % 360.0


@dataclass(frozen=True)
class RouteEdge:
    segment_id: str
    start: tuple[float, float]
    end: tuple[float, float]
    length_m: float


@dataclass(frozen=True)
class RoutePosition:
    segment_id: str
    longitude: float
    latitude: float
    heading_degrees: float


def _coordinate_key(point: tuple[float, float]) -> tuple[float, float]:
    return round(point[0], 5), round(point[1], 5)


def _feature_lines(feature: dict[str, Any]) -> list[RouteEdge]:
    properties = feature.get("properties") or {}
    segment_id = properties.get("segment_id")
    geometry = feature.get("geometry") or {}
    coordinates = geometry.get("coordinates")
    if not segment_id or geometry.get("type") != "LineString" or not isinstance(coordinates, list):
        return []
    points = [(float(point[0]), float(point[1])) for point in coordinates if len(point) >= 2]
    return [
        RouteEdge(segment_id, start, end, distance_m(start, end))
        for start, end in zip(points, points[1:])
        if start != end
    ]


def build_routes(
    feature_collection: dict[str, Any], *, center: tuple[float, float], vehicle_count: int = 3,
) -> list[list[RouteEdge]]:
    """Create stable multi-segment walks near the demo center."""
    if feature_collection.get("type") != "FeatureCollection":
        raise ValueError("road data must be a GeoJSON FeatureCollection")
    segment_edges = []
    for feature in feature_collection.get("features", []):
        edges = _feature_lines(feature)
        if edges:
            segment_edges.append(edges)
    if len(segment_edges) < vehicle_count:
        raise ValueError("not enough valid road segments for the requested vehicles")

    endpoint_index: dict[tuple[float, float], list[int]] = {}
    for index, edges in enumerate(segment_edges):
        endpoint_index.setdefault(_coordinate_key(edges[0].start), []).append(index)
        endpoint_index.setdefault(_coordinate_key(edges[-1].end), []).append(index)
    ordered_starts = sorted(
        range(len(segment_edges)),
        key=lambda index: (
            distance_m(center, segment_edges[index][0].start),
            segment_edges[index][0].segment_id,
        ),
    )
    routes: list[list[RouteEdge]] = []
    used_starts: set[int] = set()
    for vehicle_index in range(vehicle_count):
        start_index = next(index for index in ordered_starts[vehicle_index * 5:] if index not in used_starts)
        used_starts.add(start_index)
        route = list(segment_edges[start_index])
        used = {start_index}
        for _ in range(39):
            endpoint = _coordinate_key(route[-1].end)
            candidates = sorted(
                (index for index in endpoint_index.get(endpoint, []) if index not in used),
                key=lambda index: segment_edges[index][0].segment_id,
            )
            if not candidates:
                break
            next_index = candidates[0]
            edges = segment_edges[next_index]
            if _coordinate_key(edges[-1].end) == endpoint:
                edges = [RouteEdge(edge.segment_id, edge.end, edge.start, edge.length_m) for edge in reversed(edges)]
            route.extend(edges)
            used.add(next_index)
        routes.append(route)
    return routes


def sample_route(route: list[RouteEdge], distance_along_m: float) -> RoutePosition:
    if not route:
        raise ValueError("route must not be empty")
    total = sum(edge.length_m for edge in route)
    if total <= 0:
        raise ValueError("route length must be positive")
    remaining = distance_along_m % (total * 2)
    active_route = route
    if remaining > total:
        remaining = remaining - total
        active_route = [RouteEdge(edge.segment_id, edge.end, edge.start, edge.length_m) for edge in reversed(route)]
    for edge in active_route:
        if remaining <= edge.length_m:
            ratio = 0.0 if edge.length_m == 0 else remaining / edge.length_m
            longitude = edge.start[0] + (edge.end[0] - edge.start[0]) * ratio
            latitude = edge.start[1] + (edge.end[1] - edge.start[1]) * ratio
            return RoutePosition(
                segment_id=edge.segment_id,
                longitude=longitude,
                latitude=latitude,
                heading_degrees=heading_degrees(edge.start, edge.end),
            )
        remaining -= edge.length_m
    edge = active_route[-1]
    return RoutePosition(edge.segment_id, edge.end[0], edge.end[1], heading_degrees(edge.start, edge.end))
