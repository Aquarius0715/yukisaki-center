"""Merge simulated snow-pipe data with roads and load curated snapshots into PostgreSQL."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

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


def deterministic_processing_run_id(road_run_id: str, snow_pipe_run_id: str) -> str:
    digest = hashlib.sha256(f"{road_run_id}|{snow_pipe_run_id}".encode()).hexdigest()[:24]
    return f"road-snow-pipe-{digest}"


def parse_jsonl(body: bytes) -> list[dict[str, Any]]:
    try:
        records = [json.loads(line) for line in body.decode().splitlines() if line.strip()]
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("snow-pipe input must be UTF-8 JSON Lines") from error
    if not records:
        raise ValueError("snow-pipe input contains no records")
    return records


def validate_snow_pipe_record(record: dict[str, Any]) -> None:
    required = {
        "segment_id", "snow_pipe", "operation_status", "effectiveness", "updated_at",
        "source", "rule_version", "source_road_run_id", "is_simulated",
    }
    missing = sorted(required - record.keys())
    if missing:
        raise ValueError(f"snow-pipe record is missing fields: {', '.join(missing)}")
    if not isinstance(record["snow_pipe"], bool):
        raise ValueError("snow_pipe must be boolean")
    if record["operation_status"] not in {"active", "inactive", "unknown"}:
        raise ValueError("operation_status is invalid")
    if not isinstance(record["effectiveness"], (int, float)) or not 0 <= record["effectiveness"] <= 1:
        raise ValueError("effectiveness must be between 0 and 1")
    if record["is_simulated"] is not True:
        raise ValueError("MVP snow-pipe records must have is_simulated=true")
    parsed = datetime.fromisoformat(record["updated_at"])
    if parsed.tzinfo is None:
        raise ValueError("updated_at must include a timezone")


def merge_feature_collection(
    roads: dict[str, Any], snow_records: list[dict[str, Any]], *, expected_road_run_id: str,
) -> dict[str, Any]:
    features = roads.get("features")
    if roads.get("type") != "FeatureCollection" or not isinstance(features, list):
        raise ValueError("road data must be a GeoJSON FeatureCollection")
    snow_by_segment: dict[str, dict[str, Any]] = {}
    for record in snow_records:
        validate_snow_pipe_record(record)
        if record["source_road_run_id"] != expected_road_run_id:
            raise ValueError("snow-pipe record refers to a different road run")
        segment_id = record["segment_id"]
        if segment_id in snow_by_segment:
            raise ValueError(f"duplicate snow-pipe segment_id: {segment_id}")
        snow_by_segment[segment_id] = record

    merged_features: list[dict[str, Any]] = []
    road_ids: set[str] = set()
    for feature in features:
        properties = dict(feature.get("properties") or {})
        segment_id = properties.get("segment_id")
        if not segment_id:
            raise ValueError("every road feature must contain segment_id")
        if segment_id in road_ids:
            raise ValueError(f"duplicate road segment_id: {segment_id}")
        road_ids.add(segment_id)
        snow = snow_by_segment.get(segment_id)
        if snow is None:
            raise ValueError(f"snow-pipe record is missing for road segment_id: {segment_id}")
        properties.update({
            "snow_pipe": snow["snow_pipe"],
            "snow_pipe_operation_status": snow["operation_status"],
            "snow_pipe_effectiveness": snow["effectiveness"],
            "snow_pipe_updated_at": snow["updated_at"],
            "snow_pipe_source": snow["source"],
            "snow_pipe_rule_version": snow["rule_version"],
            "snow_pipe_is_simulated": True,
        })
        merged_features.append({**feature, "properties": properties})
    unknown = set(snow_by_segment) - road_ids
    if unknown:
        raise ValueError(f"snow-pipe contains unknown segment_id: {sorted(unknown)[0]}")
    return {**roads, "features": merged_features}


def _verified_object(bucket: str, key: str) -> tuple[bytes, str]:
    response = s3_client().get_object(Bucket=bucket, Key=key)
    body = response["Body"].read()
    checksum = hashlib.sha256(body).hexdigest()
    expected = response.get("Metadata", {}).get("sha256")
    if not expected or expected != checksum:
        raise ValueError(f"S3 checksum is missing or invalid: s3://{bucket}/{key}")
    return body, checksum


def merge_objects(event: dict[str, Any]) -> dict[str, Any]:
    required = {
        "roadBucket", "roadKey", "roadChecksumSha256", "roadRunId",
        "snowPipeBucket", "snowPipeKey",
        "snowPipeChecksumSha256", "snowPipeRunId", "referenceTime",
    }
    missing = sorted(required - event.keys())
    if missing:
        raise ValueError(f"merge event is missing fields: {', '.join(missing)}")
    road_bucket = event["roadBucket"]
    snow_bucket = event["snowPipeBucket"]
    road_body, road_checksum = _verified_object(road_bucket, event["roadKey"])
    snow_body, snow_checksum = _verified_object(snow_bucket, event["snowPipeKey"])
    if road_checksum != event["roadChecksumSha256"] or snow_checksum != event["snowPipeChecksumSha256"]:
        raise ValueError("merge event checksum does not match its S3 object")
    roads = json.loads(road_body)
    snow_records = parse_jsonl(snow_body)
    merged = merge_feature_collection(roads, snow_records, expected_road_run_id=event["roadRunId"])
    processing_run_id = deterministic_processing_run_id(event["roadRunId"], event["snowPipeRunId"])
    output_body = (json.dumps(merged, ensure_ascii=False, sort_keys=True) + "\n").encode()
    output_checksum = hashlib.sha256(output_body).hexdigest()
    snapshot_date = event["referenceTime"][:10]
    root = f"curated/road-segments/snapshot_date={snapshot_date}/run_id={processing_run_id}"
    output_key = f"{root}/road_segments_enriched.geojson"
    s3_client().put_object(
        Bucket=snow_bucket, Key=output_key, Body=output_body, ContentType="application/geo+json",
        Metadata={"sha256": output_checksum, "run-id": processing_run_id},
    )
    manifest = {
        "metadata_schema_version": "1.0.0",
        "run_id": processing_run_id,
        "pipeline": "road-snow-pipe-processing",
        "dataset": "road-segments-enriched",
        "source": "openstreetmap+simulated-road-name-rule",
        "source_urls": [
            f"s3://{road_bucket}/{event['roadKey']}",
            f"s3://{snow_bucket}/{event['snowPipeKey']}",
        ],
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "target_start_at": event["referenceTime"],
        "target_end_at": event["referenceTime"],
        "checksum_sha256": output_checksum,
        "status": "succeeded",
        "input_keys": [
            f"s3://{road_bucket}/{event['roadKey']}",
            f"s3://{snow_bucket}/{event['snowPipeKey']}",
        ],
        "output_keys": [f"s3://{snow_bucket}/{output_key}"],
        "output_count": len(merged["features"]),
        "source_road_run_id": event["roadRunId"],
        "source_snow_pipe_run_id": event["snowPipeRunId"],
        "is_simulated": True,
    }
    manifest_key = f"manifests/data-processing/{processing_run_id}.json"
    manifest_body = (json.dumps(manifest, ensure_ascii=False, sort_keys=True) + "\n").encode()
    s3_client().put_object(
        Bucket=snow_bucket, Key=manifest_key, Body=manifest_body, ContentType="application/json",
        Metadata={"sha256": hashlib.sha256(manifest_body).hexdigest(), "run-id": processing_run_id},
    )
    return {
        "dataset": "road-segments-enriched",
        "bucket": snow_bucket,
        "curatedKey": output_key,
        "checksumSha256": output_checksum,
        "processingRunId": processing_run_id,
        "roadRunId": event["roadRunId"],
        "snowPipeRunId": event["snowPipeRunId"],
        "recordCount": len(merged["features"]),
    }


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS data_load_runs (
  run_id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  source_key TEXT NOT NULL,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  record_count INTEGER NOT NULL CHECK (record_count >= 0)
);
CREATE TABLE IF NOT EXISTS road_segments (
  segment_id TEXT PRIMARY KEY,
  geometry_geojson JSONB NOT NULL,
  road_name TEXT,
  road_type TEXT,
  length_m NUMERIC,
  max_slope_percent NUMERIC,
  source TEXT NOT NULL,
  source_version TEXT,
  snapshot_date DATE NOT NULL,
  is_simulated BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS road_name TEXT;
CREATE TABLE IF NOT EXISTS snow_pipe_history (
  segment_id TEXT NOT NULL REFERENCES road_segments(segment_id),
  snow_pipe BOOLEAN NOT NULL,
  operation_status TEXT NOT NULL CHECK (operation_status IN ('active', 'inactive', 'unknown')),
  effectiveness NUMERIC NOT NULL CHECK (effectiveness BETWEEN 0 AND 1),
  valid_from TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  run_id TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL,
  PRIMARY KEY (segment_id, valid_from, rule_version)
);
CREATE OR REPLACE VIEW latest_snow_pipe_status AS
SELECT DISTINCT ON (segment_id)
  segment_id, snow_pipe, operation_status, effectiveness, valid_from,
  source, rule_version, run_id, is_simulated
FROM snow_pipe_history
ORDER BY segment_id, valid_from DESC, ingested_at DESC;
CREATE OR REPLACE VIEW road_segments_enriched AS
SELECT r.*, s.snow_pipe, s.operation_status, s.effectiveness,
       s.valid_from AS snow_pipe_updated_at, s.source AS snow_pipe_source,
       s.rule_version AS snow_pipe_rule_version,
       s.is_simulated AS snow_pipe_is_simulated
FROM road_segments r
LEFT JOIN latest_snow_pipe_status s USING (segment_id);
"""

ROAD_UPSERT_SQL = """
INSERT INTO road_segments (
  segment_id, geometry_geojson, road_name, road_type, length_m, max_slope_percent,
  source, source_version, snapshot_date, is_simulated
) VALUES (%s, %s::jsonb, %s, %s, %s, %s, %s, %s, %s::date, %s)
ON CONFLICT (segment_id) DO UPDATE SET
  geometry_geojson = EXCLUDED.geometry_geojson,
  road_name = EXCLUDED.road_name,
  road_type = EXCLUDED.road_type,
  length_m = EXCLUDED.length_m,
  max_slope_percent = EXCLUDED.max_slope_percent,
  source = EXCLUDED.source,
  source_version = EXCLUDED.source_version,
  snapshot_date = EXCLUDED.snapshot_date,
  is_simulated = EXCLUDED.is_simulated;
"""

SNOW_PIPE_UPSERT_SQL = """
INSERT INTO snow_pipe_history (
  segment_id, snow_pipe, operation_status, effectiveness, valid_from,
  source, rule_version, run_id, is_simulated
) VALUES (%s, %s, %s, %s, %s::timestamptz, %s, %s, %s, %s)
ON CONFLICT (segment_id, valid_from, rule_version) DO UPDATE SET
  snow_pipe = EXCLUDED.snow_pipe,
  operation_status = EXCLUDED.operation_status,
  effectiveness = EXCLUDED.effectiveness,
  source = EXCLUDED.source,
  run_id = EXCLUDED.run_id,
  is_simulated = EXCLUDED.is_simulated,
  ingested_at = now();
"""


def database_rows(feature_collection: dict[str, Any], processing_run_id: str) -> list[tuple[tuple[Any, ...], tuple[Any, ...]]]:
    rows = []
    for feature in feature_collection.get("features", []):
        properties = feature.get("properties") or {}
        road_row = (
            properties["segment_id"], json.dumps(feature.get("geometry"), sort_keys=True),
            properties.get("road_name", properties.get("name")), properties.get("highway"),
            properties.get("length_m"), properties.get("max_slope_percent"), "openstreetmap",
            properties.get("source_edge_id"), properties["snow_pipe_updated_at"][:10], False,
        )
        snow_row = (
            properties["segment_id"], properties["snow_pipe"],
            properties["snow_pipe_operation_status"], properties["snow_pipe_effectiveness"],
            properties["snow_pipe_updated_at"], properties["snow_pipe_source"],
            properties["snow_pipe_rule_version"], processing_run_id, True,
        )
        rows.append((road_row, snow_row))
    if not rows:
        raise ValueError("curated road data contains no features")
    return rows


def connect_database():
    import psycopg

    secret = database_secret()
    return psycopg.connect(
        host=secret["host"], port=secret.get("port", 5432),
        dbname=secret.get("dbname", os.environ.get("DATABASE_NAME", "yukisaki")),
        user=secret["username"], password=secret["password"], sslmode="require", connect_timeout=10,
    )


def load_message(message: dict[str, Any]) -> dict[str, Any]:
    required = {"bucket", "curatedKey", "checksumSha256", "processingRunId", "recordCount"}
    missing = sorted(required - message.keys())
    if missing:
        raise ValueError(f"load message is missing fields: {', '.join(missing)}")
    body, checksum = _verified_object(message["bucket"], message["curatedKey"])
    if checksum != message["checksumSha256"]:
        raise ValueError("load message checksum does not match curated object")
    feature_collection = json.loads(body)
    rows = database_rows(feature_collection, message["processingRunId"])
    if len(rows) != message["recordCount"]:
        raise ValueError("load message record count does not match curated object")
    source_key = f"s3://{message['bucket']}/{message['curatedKey']}"
    with connect_database() as connection:
        with connection.cursor() as cursor:
            cursor.execute(SCHEMA_SQL)
            for road_row, snow_row in rows:
                cursor.execute(ROAD_UPSERT_SQL, road_row)
                cursor.execute(SNOW_PIPE_UPSERT_SQL, snow_row)
            cursor.execute(
                """INSERT INTO data_load_runs (run_id, dataset, source_key, record_count)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (run_id) DO UPDATE SET source_key = EXCLUDED.source_key,
                     record_count = EXCLUDED.record_count, loaded_at = now()""",
                (message["processingRunId"], "road-segments-enriched", source_key, len(rows)),
            )
    LOGGER.info("Loaded %d enriched road segments from %s", len(rows), source_key)
    return {"runId": message["processingRunId"], "recordCount": len(rows)}


def merge_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return merge_objects(event)


def loader_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    failures = []
    loaded = []
    for record in event.get("Records", []):
        try:
            loaded.append(load_message(json.loads(record["body"])))
        except Exception:
            LOGGER.exception("Failed to load SQS message %s", record.get("messageId"))
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures, "loaded": loaded}
