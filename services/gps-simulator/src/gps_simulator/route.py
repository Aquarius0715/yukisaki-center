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


def _reverse_edges(edges: list[RouteEdge]) -> list[RouteEdge]:
    return [
        RouteEdge(edge.segment_id, edge.end, edge.start, edge.length_m)
        for edge in reversed(edges)
    ]


def _coverage_walk(
    start_index: int,
    segment_edges: list[list[RouteEdge]],
    endpoint_index: dict[tuple[float, float], list[int]],
    visited: set[int],
) -> list[RouteEdge]:
    """Walk one connected component and return along visited roads at dead ends."""
    start_node = _coordinate_key(segment_edges[start_index][0].start)
    node_stack = [start_node]
    return_stack: list[list[RouteEdge]] = []
    route: list[RouteEdge] = []
    while node_stack:
        node = node_stack[-1]
        candidates = sorted(
            (index for index in endpoint_index.get(node, []) if index not in visited),
            key=lambda index: (segment_edges[index][0].segment_id, index),
        )
        if candidates:
            next_index = candidates[0]
            visited.add(next_index)
            edges = segment_edges[next_index]
            oriented = edges if _coordinate_key(edges[0].start) == node else _reverse_edges(edges)
            route.extend(oriented)
            node_stack.append(_coordinate_key(oriented[-1].end))
            return_stack.append(oriented)
            continue
        node_stack.pop()
        if node_stack:
            route.extend(_reverse_edges(return_stack.pop()))
    return route


def _balanced_routes(coverage: list[RouteEdge], vehicle_count: int) -> list[list[RouteEdge]]:
    total_length = sum(edge.length_m for edge in coverage)
    if total_length <= 0:
        raise ValueError("road coverage length must be positive")
    routes: list[list[RouteEdge]] = [[] for _ in range(vehicle_count)]
    vehicle_index = 0
    target_length = total_length / vehicle_count
    route_length = 0.0
    for edge in coverage:
        if (
            vehicle_index < vehicle_count - 1
            and routes[vehicle_index]
            and route_length + edge.length_m / 2 >= target_length
        ):
            vehicle_index += 1
            route_length = 0.0
        routes[vehicle_index].append(edge)
        route_length += edge.length_m
    if any(not route for route in routes):
        raise ValueError("road coverage cannot be divided among all vehicles")
    return routes


def build_routes(
    feature_collection: dict[str, Any], *, center: tuple[float, float], vehicle_count: int = 3,
) -> list[list[RouteEdge]]:
    """Create three balanced, repeatable walks covering every mapped road segment."""
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
    visited: set[int] = set()
    component_walks = [
        _coverage_walk(index, segment_edges, endpoint_index, visited)
        for index in ordered_starts
        if index not in visited
    ]
    coverage = [edge for walk in component_walks for edge in walk]
    routes = _balanced_routes(coverage, vehicle_count)
    covered_segment_ids = {edge.segment_id for route in routes for edge in route}
    expected_segment_ids = {edges[0].segment_id for edges in segment_edges}
    if covered_segment_ids != expected_segment_ids:
        raise RuntimeError("generated routes do not cover every mapped road segment")
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
        active_route = _reverse_edges(route)
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
