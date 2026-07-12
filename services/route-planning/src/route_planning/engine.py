from __future__ import annotations

import heapq
from typing import Any


def find_route(edges: list[dict[str, Any]], start: str, goal: str) -> dict[str, Any]:
    graph: dict[str, list[tuple[str, float, str]]] = {}
    for edge in edges:
        cost = float(edge["cost"])
        if cost < 0:
            raise ValueError("edge cost must be non-negative")
        graph.setdefault(edge["from"], []).append((edge["to"], cost, edge["segment_id"]))
    queue = [(0.0, start, [], [])]
    visited: set[str] = set()
    while queue:
        cost, node, nodes, segments = heapq.heappop(queue)
        if node in visited:
            continue
        visited.add(node)
        if node == goal:
            return {"cost": cost, "nodes": nodes + [node], "segment_ids": segments}
        for target, edge_cost, segment_id in graph.get(node, []):
            if target not in visited:
                heapq.heappush(queue, (cost + edge_cost, target, nodes + [node], segments + [segment_id]))
    raise ValueError("no route found")
