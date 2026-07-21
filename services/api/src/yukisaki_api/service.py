"""GeoJSON assembly and request validation for map clients."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from decimal import Decimal
from typing import Any, Iterable

DEMO_BBOX = (138.74, 37.40, 138.84, 37.49)
MAX_FEATURES = 5000


class RequestError(ValueError):
    """A safe validation error that may be returned to the caller."""


@dataclass(frozen=True)
class MapQuery:
    bbox: tuple[float, float, float, float]
    limit: int

    @classmethod
    def parse(cls, params: dict[str, str] | None) -> "MapQuery":
        params = params or {}
        raw_bbox = params.get("bbox")
        try:
            bbox = DEMO_BBOX if not raw_bbox else tuple(float(value) for value in raw_bbox.split(","))
        except ValueError as error:
            raise RequestError("bbox must contain west,south,east,north numbers") from error
        if len(bbox) != 4:
            raise RequestError("bbox must contain west,south,east,north")
        west, south, east, north = bbox
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise RequestError("bbox coordinates or ordering are invalid")
        try:
            limit = int(params.get("limit", str(MAX_FEATURES)))
        except ValueError as error:
            raise RequestError("limit must be an integer") from error
        if not 1 <= limit <= MAX_FEATURES:
            raise RequestError(f"limit must be between 1 and {MAX_FEATURES}")
        return cls(bbox=(west, south, east, north), limit=limit)


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return datetime.combine(value, time.min, tzinfo=timezone.utc).isoformat()
    return str(value)


def _number(value: Any) -> float | int | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    return value


def _coordinates(geometry: dict[str, Any]) -> Iterable[tuple[float, float]]:
    coordinates = geometry.get("coordinates", [])
    if geometry.get("type") == "LineString":
        yield from ((float(point[0]), float(point[1])) for point in coordinates)
    elif geometry.get("type") == "MultiLineString":
        for line in coordinates:
            yield from ((float(point[0]), float(point[1])) for point in line)


def _intersects(geometry: dict[str, Any], bbox: tuple[float, float, float, float]) -> bool:
    points = list(_coordinates(geometry))
    if not points:
        return False
    west, south, east, north = bbox
    longitudes = [point[0] for point in points]
    latitudes = [point[1] for point in points]
    return min(longitudes) <= east and max(longitudes) >= west and min(latitudes) <= north and max(latitudes) >= south


def _road_feature(row: dict[str, Any]) -> dict[str, Any]:
    score_timestamp = _iso(row.get("data_timestamp"))
    snow_timestamp = _iso(row.get("snow_pipe_updated_at"))
    snapshot_timestamp = _iso(row.get("snapshot_date"))
    timestamp = score_timestamp or snow_timestamp or snapshot_timestamp
    simulated = bool(
        row.get("road_is_simulated")
        or row.get("snow_pipe_is_simulated")
        or row.get("score_is_simulated")
    )
    return {
        "type": "Feature",
        "id": row["segment_id"],
        "geometry": row["geometry_geojson"],
        "properties": {
            "segment_id": row["segment_id"],
            "road_name": row.get("road_name"),
            "road_type": row.get("road_type"),
            "length_m": _number(row.get("length_m")),
            "max_slope_percent": _number(row.get("max_slope_percent")),
            "snow_pipe": row.get("snow_pipe"),
            "snow_pipe_operation_status": row.get("operation_status"),
            "snow_pipe_effectiveness": _number(row.get("effectiveness")),
            "drivability_score": row.get("score"),
            "confidence": _number(row.get("confidence")) if row.get("confidence") is not None else 0.5,
            "score_factors": row.get("factors"),
            "score_rule_version": row.get("rule_version"),
            "last_plowed_at": _iso(row.get("observed_at")),
            "last_plowed_by": row.get("vehicle_id"),
            "data_timestamp": timestamp,
            "source": row.get("source"),
            "is_simulated": simulated,
        },
    }


def _snowplow_feature(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "Feature",
        "id": row["vehicle_id"],
        "geometry": {"type": "Point", "coordinates": [row["longitude"], row["latitude"]]},
        "properties": {
            "vehicle_id": row["vehicle_id"],
            "display_name": row.get("display_name"),
            "observed_at": _iso(row.get("observed_at")),
            "speed_kmh": _number(row.get("speed_kmh")),
            "heading_degrees": _number(row.get("heading_degrees")),
            "accuracy_m": _number(row.get("accuracy_m")),
            "operation": row.get("operation"),
            "matched_segment_id": row.get("matched_segment_id"),
            "match_distance_m": _number(row.get("match_distance_m")),
            "run_id": row.get("run_id"),
            "data_timestamp": _iso(row.get("observed_at")),
            "confidence": 0.9,
            "is_simulated": bool(row.get("is_simulated")),
        },
    }


class MapService:
    def __init__(self, repository: Any):
        self.repository = repository

    def roads(self, query: MapQuery) -> dict[str, Any]:
        matched = [
            _road_feature(row)
            for row in self.repository.road_segments()
            if _intersects(row["geometry_geojson"], query.bbox)
        ]
        features = matched[: query.limit]
        timestamps = [item["properties"]["data_timestamp"] for item in features if item["properties"]["data_timestamp"]]
        return {
            "type": "FeatureCollection",
            "features": features,
            "bbox": list(query.bbox),
            "count": len(features),
            "truncated": len(matched) > query.limit,
            "data_timestamp": max(timestamps, default=None),
            "confidence": min((item["properties"]["confidence"] for item in features), default=0.0),
            "is_simulated": any(item["properties"]["is_simulated"] for item in features),
        }

    def road(self, segment_id: str) -> dict[str, Any] | None:
        row = self.repository.road_segment(segment_id)
        return _road_feature(row) if row else None

    def snowplows(self) -> dict[str, Any]:
        features = [_snowplow_feature(row) for row in self.repository.snowplows()]
        timestamps = [item["properties"]["data_timestamp"] for item in features if item["properties"]["data_timestamp"]]
        return {
            "type": "FeatureCollection",
            "features": features,
            "count": len(features),
            "data_timestamp": max(timestamps, default=None),
            "confidence": min((item["properties"]["confidence"] for item in features), default=0.0),
            "is_simulated": any(item["properties"]["is_simulated"] for item in features),
        }

    def snapshot(self, query: MapQuery) -> dict[str, Any]:
        roads = self.roads(query)
        snowplows = self.snowplows()
        timestamps = [value for value in (roads["data_timestamp"], snowplows["data_timestamp"]) if value]
        return {
            "schema_version": "1.0",
            "data_timestamp": max(timestamps, default=None),
            "confidence": min(roads["confidence"], snowplows["confidence"]),
            "is_simulated": roads["is_simulated"] or snowplows["is_simulated"],
            "demo": {
                "target_area": "新潟県長岡市石動南町",
                "target_date": "2026-01-23",
            },
            "roads": roads,
            "snowplows": snowplows,
        }
