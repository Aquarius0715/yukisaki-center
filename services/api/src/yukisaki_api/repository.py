"""Read-only PostgreSQL projection used by the public API."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Any


ROAD_SEGMENTS_SQL = """
SELECT
  r.segment_id, r.geometry_geojson, r.road_name, r.road_type, r.length_m,
  r.max_slope_percent, r.source, r.source_version, r.snapshot_date,
  r.is_simulated AS road_is_simulated, r.snow_pipe, r.operation_status, r.effectiveness,
  r.snow_pipe_updated_at, r.snow_pipe_source, r.snow_pipe_is_simulated,
  score.data_timestamp, score.score, score.confidence, score.factors,
  score.rule_version, score.is_simulated AS score_is_simulated,
  passage.observed_at, passage.vehicle_id
FROM road_segments_enriched AS r
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
ORDER BY r.segment_id
"""

SNOWPLOWS_SQL = """
SELECT
  p.vehicle_id, v.display_name, p.observed_at, p.latitude, p.longitude,
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

    def road_segments(self) -> list[dict[str, Any]]:
        with _connect() as connection, connection.cursor() as cursor:
            cursor.execute(ROAD_SEGMENTS_SQL)
            return _rows(cursor)

    def road_segment(self, segment_id: str) -> dict[str, Any] | None:
        rows = self.road_segments()
        return next((row for row in rows if row["segment_id"] == segment_id), None)

    def snowplows(self) -> list[dict[str, Any]]:
        with _connect() as connection, connection.cursor() as cursor:
            cursor.execute(SNOWPLOWS_SQL)
            return _rows(cursor)
