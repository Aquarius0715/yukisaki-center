"""Score GPS-touched road segments, save S3 truth, and project to PostgreSQL."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

from .engine import score_segment

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)
_S3_CLIENT = None
_SECRETS_CLIENT = None
_DATABASE_SECRET = None
_SCORE_SCHEMA_ENSURED = False
# The 35 weather grid points are fixed for this MVP's pinned reference time
# (collected once, not re-collected mid-demo). Every scored segment needs its
# nearest point, so fetch them once per warm container instead of re-running
# a per-segment nearest-neighbour subquery against Postgres on every call.
_WEATHER_POINTS: list[dict[str, Any]] | None = None


def s3_client():
    global _S3_CLIENT
    if _S3_CLIENT is None:
        import boto3

        _S3_CLIENT = boto3.client("s3")
    return _S3_CLIENT


def secrets_client():
    global _SECRETS_CLIENT
    if _SECRETS_CLIENT is None:
        import boto3

        _SECRETS_CLIENT = boto3.client("secretsmanager")
    return _SECRETS_CLIENT


def database_secret() -> dict[str, Any]:
    global _DATABASE_SECRET
    if _DATABASE_SECRET is None:
        response = secrets_client().get_secret_value(SecretId=os.environ["DATABASE_SECRET_ARN"])
        _DATABASE_SECRET = json.loads(response["SecretString"])
    return _DATABASE_SECRET


def connect_database():
    import psycopg

    secret = database_secret()
    return psycopg.connect(
        host=secret["host"], port=secret.get("port", 5432),
        dbname=os.environ.get("DATABASE_NAME", secret.get("dbname", "yukisaki")),
        user=secret["username"], password=secret["password"],
    )


WEATHER_POINTS_SQL = """
SELECT latitude, longitude, temperature_c, snowfall_cm, snow_depth_m
FROM weather_hourly_windows
WHERE relative_hour = 0
  AND reference_time = (
    SELECT max(reference_time) FROM weather_hourly_windows WHERE relative_hour = 0
  )
"""

INPUT_SQL = """
SELECT r.segment_id, r.max_slope_percent, r.road_type,
       (r.geometry_geojson #>> '{coordinates,0,1}')::double precision AS segment_latitude,
       (r.geometry_geojson #>> '{coordinates,0,0}')::double precision AS segment_longitude,
       s.snow_pipe, s.operation_status,
       p.last_plowed_at
FROM road_segments r
LEFT JOIN latest_snow_pipe_status s ON s.segment_id = r.segment_id
LEFT JOIN LATERAL (
  SELECT max(observed_at) AS last_plowed_at
  FROM snowplow_segment_passages p
  WHERE p.segment_id = r.segment_id AND p.operation = 'snow_removal'
    AND p.observed_at <= %s::timestamptz
) p ON true
WHERE r.segment_id = ANY(%s)
ORDER BY r.segment_id;
"""


def _weather_points(cursor: Any) -> list[dict[str, Any]]:
    global _WEATHER_POINTS
    if _WEATHER_POINTS is None:
        cursor.execute(WEATHER_POINTS_SQL)
        _WEATHER_POINTS = [
            {
                "latitude": row[0], "longitude": row[1], "temperature_c": row[2],
                "snowfall_cm": row[3], "snow_depth_m": row[4],
            }
            for row in cursor.fetchall()
        ]
    return _WEATHER_POINTS


def _nearest_weather(
    points: list[dict[str, Any]], latitude: float | None, longitude: float | None,
) -> dict[str, Any] | None:
    if not points or latitude is None or longitude is None:
        return None
    import math

    def squared_distance(point: dict[str, Any]) -> float:
        return (point["latitude"] - latitude) ** 2 + (
            (point["longitude"] - longitude) * math.cos(math.radians(latitude))
        ) ** 2

    return min(points, key=squared_distance)


def _input_rows(cursor: Any, segment_ids: list[str], timestamp: str) -> list[dict[str, Any]]:
    weather_points = _weather_points(cursor)
    cursor.execute(INPUT_SQL, (timestamp, segment_ids))
    rows = []
    for row in cursor.fetchall():
        (
            segment_id, max_slope_percent, road_type, segment_latitude, segment_longitude,
            snow_pipe, operation_status, last_plowed_at,
        ) = row
        weather = _nearest_weather(weather_points, segment_latitude, segment_longitude)
        rows.append({
            "segment_id": segment_id, "max_slope_percent": max_slope_percent, "road_type": road_type,
            "temperature_c": weather["temperature_c"] if weather else None,
            "snowfall_1h_cm": weather["snowfall_cm"] if weather else None,
            "snow_depth_m": weather["snow_depth_m"] if weather else None,
            "snow_pipe": snow_pipe,
            "snow_pipe_operation_status": operation_status,
            "last_plowed_at": last_plowed_at.isoformat() if last_plowed_at else None,
            "data_timestamp": timestamp, "is_simulated": True,
        })
    return rows


SCORE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS drivability_scores (
  segment_id TEXT NOT NULL REFERENCES road_segments(segment_id),
  data_timestamp TIMESTAMPTZ NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  confidence NUMERIC NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  factors JSONB NOT NULL,
  rule_version TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (segment_id, data_timestamp, rule_version)
);
-- data_timestamp is the narrative "as of" moment a score claims (pinned to
-- the fixed demo reference time for a bootstrap run, live GPS-event time for
-- an incremental one) and is not reliable for picking the most-recently-
-- computed row: a bootstrap re-run always writes the same pinned
-- data_timestamp, so it can never outrank an older incremental row whose
-- data_timestamp happens to be later, even though the bootstrap write is
-- newer. ingested_at tracks actual write recency for that purpose instead.
ALTER TABLE drivability_scores
  ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS drivability_scores_route_lookup_idx
  ON drivability_scores (segment_id, rule_version, data_timestamp DESC)
  INCLUDE (score, confidence, factors, is_simulated);
CREATE INDEX IF NOT EXISTS drivability_scores_version_time_idx
  ON drivability_scores (rule_version, data_timestamp DESC);
DROP INDEX IF EXISTS drivability_scores_map_latest_idx;
CREATE INDEX IF NOT EXISTS drivability_scores_ingested_latest_idx
  ON drivability_scores (segment_id, ingested_at DESC)
  INCLUDE (score, confidence, is_simulated, data_timestamp, rule_version);
"""


def _ensure_score_schema(cursor: Any) -> None:
    # SCORE_TABLE_SQL is idempotent (CREATE TABLE/INDEX ... IF NOT EXISTS),
    # but Postgres still checks the catalog on every call. Skip once this
    # warm container has confirmed the schema exists.
    global _SCORE_SCHEMA_ENSURED
    if _SCORE_SCHEMA_ENSURED:
        return
    cursor.execute(SCORE_TABLE_SQL)
    _SCORE_SCHEMA_ENSURED = True


def _validated_timestamp(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("data timestamp is required")
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("data timestamp must include a timezone")
    return parsed.isoformat()


def _score_and_persist(
    cursor: Any,
    *,
    segment_ids: list[str],
    data_timestamp: str,
    score_run_id: str,
    source_run_ids: list[str],
) -> dict[str, Any]:
    results = [score_segment(item) for item in _input_rows(cursor, segment_ids, data_timestamp)]
    if len(results) != len(segment_ids):
        raise ValueError("one or more scoring road segments do not exist")

    body = b"".join(
        (json.dumps(item, ensure_ascii=False, sort_keys=True, default=str) + "\n").encode()
        for item in results
    )
    checksum = hashlib.sha256(body).hexdigest()
    snapshot_date = datetime.fromisoformat(data_timestamp).date().isoformat()
    key = f"curated/drivability-scores/snapshot_date={snapshot_date}/run_id={score_run_id}/scores.jsonl"
    s3_client().put_object(
        Bucket=os.environ["DATA_BUCKET"], Key=key, Body=body,
        ContentType="application/x-ndjson",
        Metadata={"sha256": checksum, "run-id": score_run_id},
    )

    projection_rows = [
        (
            result["segment_id"], result["data_timestamp"], result["score"],
            result["confidence"], json.dumps({
                "applied_rules": result["factors"], "inputs": result["inputs"],
                "source_run_ids": source_run_ids,
            }, ensure_ascii=False, default=str), result["rule_version"],
        )
        for result in results
    ]
    cursor.executemany(
        """INSERT INTO drivability_scores (
             segment_id, data_timestamp, score, confidence, factors,
             rule_version, is_simulated, ingested_at
           ) VALUES (%s, %s::timestamptz, %s, %s, %s::jsonb, %s, true, now())
           ON CONFLICT (segment_id, data_timestamp, rule_version) DO UPDATE SET
             score=EXCLUDED.score, confidence=EXCLUDED.confidence,
             factors=EXCLUDED.factors, is_simulated=true, ingested_at=now()""",
        projection_rows,
    )
    cursor.execute(
        """INSERT INTO data_load_runs (run_id, dataset, source_key, record_count)
           VALUES (%s, 'drivability-scores', %s, %s)
           ON CONFLICT (run_id) DO UPDATE SET source_key=EXCLUDED.source_key,
             record_count=EXCLUDED.record_count, loaded_at=now()""",
        (score_run_id, f"s3://{os.environ['DATA_BUCKET']}/{key}", len(results)),
    )
    return {
        "runId": score_run_id,
        "recordCount": len(results),
        "key": key,
        "sha256": checksum,
        "dataTimestamp": data_timestamp,
    }


def score_message(message: dict[str, Any]) -> dict[str, Any]:
    segment_ids = sorted(set(message.get("segmentIds", [])))
    if not segment_ids:
        raise ValueError("scoring message contains no segment IDs")
    data_timestamp = _validated_timestamp(message.get("latestObservedAt"))
    processing_run_id = message.get("processingRunId")
    if not isinstance(processing_run_id, str) or not processing_run_id:
        raise ValueError("processingRunId is required")
    with connect_database() as connection:
        with connection.cursor() as cursor:
            _ensure_score_schema(cursor)
            cursor.execute("SELECT 1 FROM data_load_runs WHERE run_id = %s", (processing_run_id,))
            if cursor.fetchone() is None:
                raise RuntimeError("GPS PostgreSQL load is not complete; retry scoring later")
            result = _score_and_persist(
                cursor,
                segment_ids=segment_ids,
                data_timestamp=data_timestamp,
                score_run_id=f"score-{processing_run_id}",
                source_run_ids=[processing_run_id],
            )
    LOGGER.info("Scored %d GPS-touched road segments", result["recordCount"])
    return result


def score_all_segments(data_timestamp: str) -> dict[str, Any]:
    parsed_timestamp = datetime.fromisoformat(data_timestamp)
    if parsed_timestamp.tzinfo is None:
        raise ValueError("dataTimestamp must include a timezone")
    bootstrap_run_id = f"bootstrap-all-roads-{parsed_timestamp.strftime('%Y%m%dT%H%M%S%z')}"
    with connect_database() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT segment_id FROM road_segments ORDER BY segment_id")
            segment_ids = [row[0] for row in cursor.fetchall()]
            if not segment_ids:
                raise RuntimeError("road_segments contains no rows")
            cursor.execute(
                """INSERT INTO data_load_runs (run_id, dataset, source_key, record_count)
                   VALUES (%s, 'drivability-bootstrap', %s, %s)
                   ON CONFLICT (run_id) DO UPDATE SET record_count=EXCLUDED.record_count,
                     loaded_at=now()""",
                (bootstrap_run_id, "internal://drivability-bootstrap/all-road-segments", len(segment_ids)),
            )
    return score_message({
        "processingRunId": bootstrap_run_id,
        "segmentIds": segment_ids,
        "latestObservedAt": data_timestamp,
    })


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    if event.get("mode") == "bootstrap-all-road-segments":
        return {
            "batchItemFailures": [],
            "scored": [score_all_segments(event["dataTimestamp"])],
        }
    failures = []
    scored = []
    for record in event.get("Records", []):
        try:
            scored.append(score_message(json.loads(record["body"])))
        except Exception:
            LOGGER.exception("Failed to score GPS batch %s", record.get("messageId"))
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures, "scored": scored}
