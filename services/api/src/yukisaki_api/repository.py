"""Read-only PostgreSQL projection used by the public API."""

from __future__ import annotations

import json
import logging
import os
import time
from functools import lru_cache
from typing import Any


LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)


ROAD_SEGMENTS_SELECT = """
SELECT
  r.segment_id, r.geometry_geojson, r.road_name, r.road_type, r.length_m,
  r.max_slope_percent, r.source, r.source_version, r.snapshot_date,
  r.is_simulated AS road_is_simulated, snow.snow_pipe, snow.operation_status,
  snow.effectiveness, snow.valid_from AS snow_pipe_updated_at,
  snow.source AS snow_pipe_source, snow.is_simulated AS snow_pipe_is_simulated,
  score.data_timestamp, score.score, score.confidence, score.factors,
  score.rule_version, score.is_simulated AS score_is_simulated,
  passage.observed_at, passage.vehicle_id
FROM road_segments AS r
LEFT JOIN LATERAL (
  SELECT snow_pipe, operation_status, effectiveness, valid_from, source, is_simulated
  FROM snow_pipe_history
  WHERE segment_id = r.segment_id
  ORDER BY valid_from DESC, ingested_at DESC
  LIMIT 1
) AS snow ON true
LEFT JOIN LATERAL (
  SELECT data_timestamp, score, confidence, factors, rule_version, is_simulated
  FROM drivability_scores
  WHERE segment_id = r.segment_id
  ORDER BY data_timestamp DESC, rule_version DESC
  LIMIT 1
) AS score ON true
LEFT JOIN LATERAL (
  SELECT observed_at, vehicle_id
  FROM snowplow_segment_passages
  WHERE segment_id = r.segment_id
  ORDER BY observed_at DESC
  LIMIT 1
) AS passage ON true
"""

ROAD_SEGMENTS_SQL = """
WITH spatial_candidate_ids AS MATERIALIZED (
  SELECT segment_id
  FROM road_segments
  WHERE box(
      point(min_longitude, min_latitude),
      point(max_longitude, max_latitude)
    ) && box(point(%s, %s), point(%s, %s))
),
paged_candidate_ids AS MATERIALIZED (
  SELECT segment_id
  FROM spatial_candidate_ids
  WHERE segment_id > %s
  ORDER BY segment_id
  LIMIT %s
),
candidates AS MATERIALIZED (
  SELECT
    r.segment_id, r.geometry_geojson, r.road_name, r.road_type, r.length_m,
    r.max_slope_percent, r.source, r.source_version, r.snapshot_date,
    r.is_simulated
  FROM road_segments AS r
  JOIN paged_candidate_ids AS p USING (segment_id)
)
""" + ROAD_SEGMENTS_SELECT.replace(
    "FROM road_segments AS r",
    "FROM candidates AS r",
) + """
ORDER BY r.segment_id
"""

ROAD_MAP_SEGMENTS_SQL = """
WITH spatial_candidate_ids AS MATERIALIZED (
  SELECT segment_id
  FROM road_segments
  WHERE box(
      point(min_longitude, min_latitude),
      point(max_longitude, max_latitude)
    ) && box(point(%s, %s), point(%s, %s))
),
paged_candidate_ids AS MATERIALIZED (
  SELECT segment_id
  FROM spatial_candidate_ids
  WHERE segment_id > %s
  ORDER BY segment_id
  LIMIT %s
),
candidates AS MATERIALIZED (
  SELECT
    r.segment_id, r.geometry_geojson, r.road_name, r.road_type,
    r.snapshot_date, r.is_simulated
  FROM road_segments AS r
  JOIN paged_candidate_ids AS p USING (segment_id)
)
SELECT
  r.segment_id, r.geometry_geojson, r.road_name, r.road_type,
  r.snapshot_date, r.is_simulated AS road_is_simulated,
  snow.snow_pipe, snow.operation_status,
  snow.valid_from AS snow_pipe_updated_at,
  snow.is_simulated AS snow_pipe_is_simulated,
  score.data_timestamp, score.score, score.confidence,
  score.is_simulated AS score_is_simulated
FROM candidates AS r
LEFT JOIN LATERAL (
  SELECT snow_pipe, operation_status, valid_from, is_simulated
  FROM snow_pipe_history
  WHERE segment_id = r.segment_id
  ORDER BY valid_from DESC, ingested_at DESC
  LIMIT 1
) AS snow ON true
LEFT JOIN LATERAL (
  SELECT data_timestamp, score, confidence, is_simulated
  FROM drivability_scores
  WHERE segment_id = r.segment_id
  ORDER BY data_timestamp DESC, rule_version DESC
  LIMIT 1
) AS score ON true
ORDER BY r.segment_id
"""

ROAD_SEGMENT_SQL = ROAD_SEGMENTS_SELECT + """
WHERE r.segment_id = %s
LIMIT 1
"""

SNOWPLOWS_SQL = """
SELECT
  p.vehicle_id, v.display_name, p.observed_at, p.received_at, p.latitude, p.longitude,
  p.speed_kmh, p.heading_degrees, p.accuracy_m, p.operation,
  p.matched_segment_id, p.match_distance_m, p.run_id, p.is_simulated
FROM snowplow_positions_latest AS p
JOIN snowplow_vehicles AS v USING (vehicle_id)
ORDER BY p.vehicle_id
"""


@lru_cache(maxsize=1)
def _database_secret() -> dict[str, Any]:
    import boto3

    response = boto3.client("secretsmanager").get_secret_value(
        SecretId=os.environ["DATABASE_SECRET_ARN"]
    )
    return json.loads(response["SecretString"])


def _connect():
    import psycopg

    secret = _database_secret()
    return psycopg.connect(
        host=secret["host"],
        port=secret.get("port", 5432),
        dbname=secret.get("dbname", os.environ.get("DATABASE_NAME", "yukisaki")),
        user=secret["username"],
        password=secret["password"],
        sslmode="require",
        connect_timeout=5,
        options="-c statement_timeout=12000",
    )


def _rows(cursor: Any) -> list[dict[str, Any]]:
    columns = [column.name for column in cursor.description]
    return [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]


class PostgresMapRepository:
    """Fetches serving projections without changing database state."""

    def road_segments(
        self,
        bbox: tuple[float, float, float, float],
        limit: int,
        cursor: str | None = None,
        map_only: bool = False,
    ) -> list[dict[str, Any]]:
        west, south, east, north = bbox
        after_segment_id = cursor or ""
        started_at = time.perf_counter()
        with _connect() as connection:
            connected_at = time.perf_counter()
            database_cursor = connection.cursor()
            with database_cursor:
                query_started_at = time.perf_counter()
                database_cursor.execute(
                    ROAD_MAP_SEGMENTS_SQL if map_only else ROAD_SEGMENTS_SQL,
                    (west, south, east, north, after_segment_id, limit + 1),
                )
                rows = _rows(database_cursor)
                completed_at = time.perf_counter()
        LOGGER.info(
            "road_segments completed map_only=%s limit=%d rows=%d "
            "connect_ms=%.1f query_ms=%.1f total_ms=%.1f",
            map_only,
            limit,
            len(rows),
            (connected_at - started_at) * 1000,
            (completed_at - query_started_at) * 1000,
            (completed_at - started_at) * 1000,
        )
        return rows

    def road_segment(self, segment_id: str) -> dict[str, Any] | None:
        with _connect() as connection, connection.cursor() as cursor:
            cursor.execute(ROAD_SEGMENT_SQL, (segment_id,))
            row = cursor.fetchone()
            if row is None:
                return None
            columns = [column.name for column in cursor.description]
            return dict(zip(columns, row, strict=True))

    def snowplows(self) -> list[dict[str, Any]]:
        with _connect() as connection, connection.cursor() as cursor:
            cursor.execute(SNOWPLOWS_SQL)
            return _rows(cursor)
