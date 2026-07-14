"""Deterministic de-duplication and metric road segmentation."""
from __future__ import annotations

import hashlib
import json
import logging
import math
from collections.abc import Iterable
from typing import Any

import geopandas as gpd
from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge, substring

LOGGER = logging.getLogger(__name__)

KEEP_COLUMNS = (
    "osmid", "name", "highway", "oneway", "maxspeed", "length", "access", "service",
    "lanes", "lanes:forward", "lanes:backward", "surface", "width", "lit", "sidewalk",
    "cycleway", "bridge", "tunnel", "junction", "parking", "ref",
)


def json_value(value: Any) -> Any:
    """Convert OSM values, including lists, into GeoJSON-compatible values."""
    if isinstance(value, float) and math.isnan(value):
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Iterable) and not isinstance(value, (str, bytes, dict)):
        return "; ".join(str(item) for item in value)
    return str(value)


def _canonical_coords(geometry: LineString | MultiLineString) -> str:
    """Create direction-independent rounded geometry text for duplicate detection."""
    lines = list(geometry.geoms) if isinstance(geometry, MultiLineString) else [geometry]
    parts = []
    for line in lines:
        coords = [(round(x, 7), round(y, 7)) for x, y in line.coords]
        parts.append(min(coords, list(reversed(coords))))
    return json.dumps(sorted(parts), separators=(",", ":"))


def source_edge_id(row: Any) -> str:
    """Generate a deterministic identifier for an unsegmented OSM edge."""
    payload = {
        "osmid": json_value(row.get("osmid")), "u": json_value(row.get("u")),
        "v": json_value(row.get("v")), "key": json_value(row.get("key")),
        "geometry": _canonical_coords(row.geometry),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:24]


def deduplicate_edges(edges: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Remove only reversible, same-tag, same-shape directed duplicates."""
    keep: list[int] = []
    seen: set[str] = set()
    for index, row in edges.iterrows():
        geometry = row.geometry
        if geometry is None or geometry.is_empty or not isinstance(geometry, (LineString, MultiLineString)):
            keep.append(index)
            continue
        # One-way edges are never collapsed: direction is semantically meaningful.
        if str(row.get("oneway", False)).strip().lower() in {"true", "yes", "1"}:
            keep.append(index)
            continue
        endpoints = sorted((str(row.get("u")), str(row.get("v"))))
        tags = [json_value(row.get(name)) for name in ("osmid", "name", "highway", "access", "service")]
        signature = json.dumps([endpoints, tags, _canonical_coords(geometry)], ensure_ascii=False, sort_keys=True)
        if signature not in seen:
            seen.add(signature)
            keep.append(index)
    return edges.loc[keep].copy()


def segment_count_for_length(length_m: float, target_m: float) -> int:
    """Choose the floor/ceiling count whose uniform length is closest to target."""
    if length_m <= 0:
        return 0
    candidates = {max(1, math.floor(length_m / target_m)), max(1, math.ceil(length_m / target_m))}
    return min(candidates, key=lambda count: (abs(length_m / count - target_m), -count))


def _line(geometry: Any) -> LineString | None:
    """Normalize a usable linear geometry to one LineString where possible."""
    if not isinstance(geometry, (LineString, MultiLineString)) or geometry.is_empty:
        return None
    merged = linemerge(geometry) if isinstance(geometry, MultiLineString) else geometry
    if isinstance(merged, LineString) and merged.is_valid and merged.length > 1e-8:
        return merged
    return None


def _segment_id(source_id: str, osm_id: Any, index: int, line: LineString) -> str:
    coords = list(line.coords)
    payload = f"{json_value(osm_id)}|{source_id}|{index}|{coords[0][0]:.7f},{coords[0][1]:.7f}|{coords[-1][0]:.7f},{coords[-1][1]:.7f}"
    return hashlib.sha256(payload.encode()).hexdigest()[:32]


def segment_edges(edges_metric: gpd.GeoDataFrame, target_m: float) -> tuple[gpd.GeoDataFrame, int]:
    """Split metric edge geometries into near-target, equal-length LineStrings."""
    if target_m <= 0:
        raise ValueError("segment length must be greater than zero")
    records: list[dict[str, Any]] = []
    skipped = 0
    for _, row in edges_metric.iterrows():
        line = _line(row.geometry)
        if line is None:
            skipped += 1
            LOGGER.warning("Skipping empty or unsupported edge geometry")
            continue
        count = segment_count_for_length(line.length, target_m)
        if not count:
            skipped += 1
            continue
        edge_id = source_edge_id(row)
        for index in range(count):
            part = substring(line, index * line.length / count, (index + 1) * line.length / count)
            if not isinstance(part, LineString) or part.is_empty or part.length <= 1e-8:
                skipped += 1
                continue
            record = {column: json_value(row.get(column)) for column in KEEP_COLUMNS}
            record.update({
                "source_edge_id": edge_id, "osm_id": json_value(row.get("osmid")),
                "road_name": json_value(row.get("name")),
                "lanes_forward": json_value(row.get("lanes:forward")),
                "lanes_backward": json_value(row.get("lanes:backward")),
                "segment_index": index, "segment_count": count,
                "length_m": round(part.length, 2), "snow_depth_cm": None,
                "snow_level": "unknown", "snow_updated_at": None, "geometry": part,
            })
            record["segment_id"] = _segment_id(edge_id, row.get("osmid"), index, part)
            records.append(record)
    if not records:
        return gpd.GeoDataFrame({"geometry": []}, geometry="geometry", crs=edges_metric.crs), skipped
    return gpd.GeoDataFrame(records, geometry="geometry", crs=edges_metric.crs), skipped


def add_wgs84_endpoints(segments_metric: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Return segments in WGS84 with endpoint latitude/longitude attributes."""
    result = segments_metric.to_crs("EPSG:4326")
    result["start_lon"] = result.geometry.map(lambda line: round(line.coords[0][0], 7))
    result["start_lat"] = result.geometry.map(lambda line: round(line.coords[0][1], 7))
    result["end_lon"] = result.geometry.map(lambda line: round(line.coords[-1][0], 7))
    result["end_lat"] = result.geometry.map(lambda line: round(line.coords[-1][1], 7))
    return result

