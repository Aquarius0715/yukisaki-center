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


INPUT_SQL = """
SELECT r.segment_id, r.max_slope_percent,
       w.temperature_c, w.snowfall_cm, w.snow_depth_m,
       s.snow_pipe, s.operation_status,
       p.last_plowed_at
FROM road_segments r
LEFT JOIN LATERAL (
  SELECT temperature_c, snowfall_cm, snow_depth_m
  FROM weather_hourly_windows
  WHERE relative_hour = 0
  ORDER BY reference_time DESC LIMIT 1
) w ON true
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


def _input_rows(cursor: Any, segment_ids: list[str], timestamp: str) -> list[dict[str, Any]]:
    cursor.execute(INPUT_SQL, (timestamp, segment_ids))
    rows = []
    for row in cursor.fetchall():
        rows.append({
            "segment_id": row[0], "max_slope_percent": row[1], "temperature_c": row[2],
            "snowfall_1h_cm": row[3], "snow_depth_m": row[4], "snow_pipe": row[5],
            "snow_pipe_operation_status": row[6],
            "last_plowed_at": row[7].isoformat() if row[7] else None,
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
"""


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
             rule_version, is_simulated
           ) VALUES (%s, %s::timestamptz, %s, %s, %s::jsonb, %s, true)
           ON CONFLICT (segment_id, data_timestamp, rule_version) DO UPDATE SET
             score=EXCLUDED.score, confidence=EXCLUDED.confidence,
             factors=EXCLUDED.factors, is_simulated=true""",
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
            cursor.execute(SCORE_TABLE_SQL)
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


def score_all_segments(event: dict[str, Any]) -> dict[str, Any]:
    data_timestamp = _validated_timestamp(
        event.get("dataTimestamp") or os.environ.get("TARGET_REFERENCE_TIME")
    )
    timestamp_token = datetime.fromisoformat(data_timestamp).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    score_run_id = f"score-initial-all-roads-{timestamp_token}"
    with connect_database() as connection:
        with connection.cursor() as cursor:
            cursor.execute(SCORE_TABLE_SQL)
            cursor.execute("SELECT segment_id FROM road_segments ORDER BY segment_id")
            segment_ids = [row[0] for row in cursor.fetchall()]
            if not segment_ids:
                raise RuntimeError("road_segments is empty")
            result = _score_and_persist(
                cursor,
                segment_ids=segment_ids,
                data_timestamp=data_timestamp,
                score_run_id=score_run_id,
                source_run_ids=[score_run_id],
            )
    LOGGER.info("Scored all %d road segments", result["recordCount"])
    return result


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    if event.get("action") == "score_all":
        return score_all_segments(event)
    failures = []
    scored = []
    for record in event.get("Records", []):
        try:
            scored.append(score_message(json.loads(record["body"])))
        except Exception:
            LOGGER.exception("Failed to score GPS batch %s", record.get("messageId"))
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures, "scored": scored}
