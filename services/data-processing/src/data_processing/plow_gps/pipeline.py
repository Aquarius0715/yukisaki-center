"""Map-match simulated GPS batches, persist curated S3, and load PostgreSQL projections."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
from datetime import datetime, timezone
from typing import Any

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)
EARTH_RADIUS_M = 6_371_000.0
_S3_CLIENT = None
_SQS_CLIENT = None
_SECRETS_CLIENT = None
_DATABASE_SECRET = None
_ROAD_INDEX = None


def s3_client():
    global _S3_CLIENT
    if _S3_CLIENT is None:
        import boto3

        _S3_CLIENT = boto3.client("s3")
    return _S3_CLIENT


def sqs_client():
    global _SQS_CLIENT
    if _SQS_CLIENT is None:
        import boto3

        _SQS_CLIENT = boto3.client("sqs")
    return _SQS_CLIENT


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


def _to_xy(point: tuple[float, float], origin_latitude: float) -> tuple[float, float]:
    longitude, latitude = point
    return (
        math.radians(longitude) * math.cos(math.radians(origin_latitude)) * EARTH_RADIUS_M,
        math.radians(latitude) * EARTH_RADIUS_M,
    )


def point_to_line_distance_m(
    point: tuple[float, float], start: tuple[float, float], end: tuple[float, float],
) -> float:
    origin_latitude = point[1]
    px, py = _to_xy(point, origin_latitude)
    ax, ay = _to_xy(start, origin_latitude)
    bx, by = _to_xy(end, origin_latitude)
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    ratio = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy))


def build_road_index(feature_collection: dict[str, Any]) -> list[tuple[str, list[tuple[float, float]]]]:
    if feature_collection.get("type") != "FeatureCollection":
        raise ValueError("road data must be a GeoJSON FeatureCollection")
    index = []
    for feature in feature_collection.get("features", []):
        properties = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates")
        if properties.get("segment_id") and geometry.get("type") == "LineString" and coordinates:
            points = [(float(item[0]), float(item[1])) for item in coordinates if len(item) >= 2]
            if len(points) >= 2:
                index.append((properties["segment_id"], points))
    if not index:
        raise ValueError("road data contains no valid LineString features")
    return index


def match_segment(
    latitude: float, longitude: float, road_index: list[tuple[str, list[tuple[float, float]]]],
) -> tuple[str, float]:
    point = (longitude, latitude)
    best: tuple[str, float] | None = None
    for segment_id, coordinates in road_index:
        distance = min(
            point_to_line_distance_m(point, start, end)
            for start, end in zip(coordinates, coordinates[1:])
        )
        if best is None or (distance, segment_id) < (best[1], best[0]):
            best = (segment_id, distance)
    assert best is not None
    return best


def _latest_road_index() -> list[tuple[str, list[tuple[float, float]]]]:
    global _ROAD_INDEX
    if _ROAD_INDEX is None:
        bucket = os.environ["ROAD_CURATED_BUCKET"]
        response = s3_client().list_objects_v2(Bucket=bucket, Prefix="curated/road-segments/")
        objects = [item for item in response.get("Contents", []) if item["Key"].endswith(".geojson")]
        if not objects:
            raise RuntimeError("no curated road data is available for map matching")
        latest = max(objects, key=lambda item: item["LastModified"])
        body = s3_client().get_object(Bucket=bucket, Key=latest["Key"])["Body"].read()
        _ROAD_INDEX = build_road_index(json.loads(body))
    return _ROAD_INDEX


def decode_eventbridge_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events = []
    for record in records:
        envelope = json.loads(record["body"])
        value = envelope["detail"]
        if value.get("is_simulated") is not True or not value.get("event_id"):
            raise ValueError("GPS input is not a valid simulated event")
        events.append(value)
    if not events:
        raise ValueError("SQS batch contains no GPS events")
    return events


def process_events(
    events: list[dict[str, Any]], *, bucket: str, road_index: list[tuple[str, list[tuple[float, float]]]],
) -> dict[str, Any]:
    matched = []
    for event in events:
        segment_id, distance = match_segment(float(event["latitude"]), float(event["longitude"]), road_index)
        matched.append({
            **event,
            "matched_segment_id": segment_id,
            "match_distance_m": round(distance, 3),
            "ground_truth_match": segment_id == event.get("ground_truth_segment_id"),
            "processed_at": datetime.now(timezone.utc).isoformat(),
        })
    matched.sort(key=lambda item: (item["observed_at"], item["vehicle_id"], item["event_id"]))
    run_seed = "|".join(event["event_id"] for event in matched)
    processing_run_id = f"gps-process-{hashlib.sha256(run_seed.encode()).hexdigest()[:24]}"
    body = b"".join(
        (json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n").encode() for event in matched
    )
    checksum = hashlib.sha256(body).hexdigest()
    first = min(datetime.fromisoformat(event["observed_at"]) for event in matched)
    last = max(datetime.fromisoformat(event["observed_at"]) for event in matched)
    root = f"event_date={first.date().isoformat()}/hour={first.hour:02d}/run_id={processing_run_id}"
    normalized_key = f"normalized/simulated/plow-gps/{root}/events.jsonl"
    curated_key = f"curated/snowplow-passages/{root}/passages.jsonl"
    for key in (normalized_key, curated_key):
        s3_client().put_object(
            Bucket=bucket, Key=key, Body=body, ContentType="application/x-ndjson",
            Metadata={"sha256": checksum, "run-id": processing_run_id},
        )
    manifest = {
        "metadata_schema_version": "1.0.0", "run_id": processing_run_id,
        "pipeline": "plow-gps-map-matching", "dataset": "snowplow-passages",
        "source": "yukisaki-gps-simulator", "source_urls": sorted({f"eventbridge://{e['run_id']}" for e in matched}),
        "fetched_at": datetime.now(timezone.utc).isoformat(), "target_start_at": first.isoformat(),
        "target_end_at": last.isoformat(), "checksum_sha256": checksum, "status": "succeeded",
        "output_keys": [f"s3://{bucket}/{normalized_key}", f"s3://{bucket}/{curated_key}"],
        "output_count": len(matched), "is_simulated": True,
    }
    manifest_key = f"manifests/data-processing/{processing_run_id}.json"
    manifest_body = (json.dumps(manifest, ensure_ascii=False, sort_keys=True) + "\n").encode()
    s3_client().put_object(
        Bucket=bucket, Key=manifest_key, Body=manifest_body, ContentType="application/json",
        Metadata={"sha256": hashlib.sha256(manifest_body).hexdigest(), "run-id": processing_run_id},
    )
    return {
        "bucket": bucket, "curatedKey": curated_key, "checksumSha256": checksum,
        "processingRunId": processing_run_id, "recordCount": len(matched),
        "segmentIds": sorted({event["matched_segment_id"] for event in matched}),
        "latestObservedAt": last.isoformat(),
    }


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS data_load_runs (
  run_id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  source_key TEXT NOT NULL,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  record_count INTEGER NOT NULL CHECK (record_count >= 0)
);
CREATE TABLE IF NOT EXISTS snowplow_vehicles (
  vehicle_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  source TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL
);
CREATE TABLE IF NOT EXISTS snowplow_positions_latest (
  vehicle_id TEXT PRIMARY KEY REFERENCES snowplow_vehicles(vehicle_id),
  observed_at TIMESTAMPTZ NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  speed_kmh NUMERIC NOT NULL,
  heading_degrees NUMERIC NOT NULL,
  accuracy_m NUMERIC NOT NULL,
  operation TEXT NOT NULL,
  matched_segment_id TEXT NOT NULL REFERENCES road_segments(segment_id),
  match_distance_m NUMERIC NOT NULL,
  run_id TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS snowplow_segment_passages (
  event_id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES snowplow_vehicles(vehicle_id),
  segment_id TEXT NOT NULL REFERENCES road_segments(segment_id),
  observed_at TIMESTAMPTZ NOT NULL,
  operation TEXT NOT NULL,
  speed_kmh NUMERIC NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  match_distance_m NUMERIC NOT NULL,
  ground_truth_segment_id TEXT,
  ground_truth_match BOOLEAN,
  source TEXT NOT NULL,
  run_id TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS snowplow_passages_segment_time_idx
  ON snowplow_segment_passages (segment_id, observed_at DESC);
"""


def _verified_object(bucket: str, key: str, expected_checksum: str) -> list[dict[str, Any]]:
    response = s3_client().get_object(Bucket=bucket, Key=key)
    body = response["Body"].read()
    checksum = hashlib.sha256(body).hexdigest()
    metadata_checksum = response.get("Metadata", {}).get("sha256")
    if checksum != expected_checksum or metadata_checksum != checksum:
        raise ValueError("curated GPS checksum is missing or invalid")
    return [json.loads(line) for line in body.decode().splitlines() if line.strip()]


def load_message(message: dict[str, Any]) -> dict[str, Any]:
    records = _verified_object(message["bucket"], message["curatedKey"], message["checksumSha256"])
    if len(records) != message["recordCount"]:
        raise ValueError("curated GPS record count does not match load message")
    with connect_database() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock(hashtext('yukisaki-snowplow-gps-loader'))"
            )
            cursor.execute(SCHEMA_SQL)
            for record in records:
                cursor.execute(
                    """INSERT INTO snowplow_vehicles (vehicle_id, display_name, source, is_simulated)
                       VALUES (%s, %s, %s, true)
                       ON CONFLICT (vehicle_id) DO UPDATE SET source = EXCLUDED.source""",
                    (record["vehicle_id"], record["vehicle_id"], record["source"]),
                )
                cursor.execute(
                    """INSERT INTO snowplow_positions_latest (
                         vehicle_id, observed_at, latitude, longitude, speed_kmh, heading_degrees,
                         accuracy_m, operation, matched_segment_id, match_distance_m, run_id, is_simulated
                       ) VALUES (%s, %s::timestamptz, %s, %s, %s, %s, %s, %s, %s, %s, %s, true)
                       ON CONFLICT (vehicle_id) DO UPDATE SET
                         observed_at=EXCLUDED.observed_at, latitude=EXCLUDED.latitude,
                         longitude=EXCLUDED.longitude, speed_kmh=EXCLUDED.speed_kmh,
                         heading_degrees=EXCLUDED.heading_degrees, accuracy_m=EXCLUDED.accuracy_m,
                         operation=EXCLUDED.operation, matched_segment_id=EXCLUDED.matched_segment_id,
                         match_distance_m=EXCLUDED.match_distance_m, run_id=EXCLUDED.run_id,
                         is_simulated=true, updated_at=now()
                       WHERE EXCLUDED.observed_at >= snowplow_positions_latest.observed_at""",
                    (
                        record["vehicle_id"], record["observed_at"], record["latitude"],
                        record["longitude"], record["speed_kmh"], record["heading_degrees"],
                        record["accuracy_m"], record["operation"], record["matched_segment_id"],
                        record["match_distance_m"], message["processingRunId"],
                    ),
                )
                cursor.execute(
                    """INSERT INTO snowplow_segment_passages (
                         event_id, vehicle_id, segment_id, observed_at, operation, speed_kmh,
                         latitude, longitude, match_distance_m, ground_truth_segment_id,
                         ground_truth_match, source, run_id, is_simulated
                       ) VALUES (%s, %s, %s, %s::timestamptz, %s, %s, %s, %s, %s, %s, %s, %s, %s, true)
                       ON CONFLICT (event_id) DO NOTHING""",
                    (
                        record["event_id"], record["vehicle_id"], record["matched_segment_id"],
                        record["observed_at"], record["operation"], record["speed_kmh"],
                        record["latitude"], record["longitude"], record["match_distance_m"],
                        record.get("ground_truth_segment_id"), record.get("ground_truth_match"),
                        record["source"], message["processingRunId"],
                    ),
                )
            cursor.execute(
                """INSERT INTO data_load_runs (run_id, dataset, source_key, record_count)
                   VALUES (%s, 'snowplow-passages', %s, %s)
                   ON CONFLICT (run_id) DO UPDATE SET source_key=EXCLUDED.source_key,
                     record_count=EXCLUDED.record_count, loaded_at=now()""",
                (
                    message["processingRunId"],
                    f"s3://{message['bucket']}/{message['curatedKey']}", len(records),
                ),
            )
    LOGGER.info("Loaded %d simulated GPS passages", len(records))
    return {"runId": message["processingRunId"], "recordCount": len(records)}


def processor_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    message = process_events(
        decode_eventbridge_records(event.get("Records", [])),
        bucket=os.environ["DATA_BUCKET"], road_index=_latest_road_index(),
    )
    body = json.dumps(message, ensure_ascii=False, sort_keys=True)
    sqs_client().send_message(QueueUrl=os.environ["GPS_LOAD_QUEUE_URL"], MessageBody=body)
    sqs_client().send_message(
        QueueUrl=os.environ["SCORING_QUEUE_URL"], MessageBody=body,
        DelaySeconds=int(os.environ.get("SCORING_DELAY_SECONDS", "60")),
    )
    return message


def loader_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    failures = []
    loaded = []
    for record in event.get("Records", []):
        try:
            loaded.append(load_message(json.loads(record["body"])))
        except Exception:
            LOGGER.exception("Failed to load GPS message %s", record.get("messageId"))
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures, "loaded": loaded}
