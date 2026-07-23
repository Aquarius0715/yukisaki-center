"""Merge simulated snow-pipe data with roads and load curated snapshots into PostgreSQL."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)
_S3_CLIENT = None
_SECRETS_CLIENT = None
_DATABASE_SECRET = None

DEFAULT_SPEED_KMH = {
    "motorway": 80.0, "trunk": 60.0, "primary": 50.0, "secondary": 40.0,
    "tertiary": 40.0, "residential": 30.0, "unclassified": 30.0,
    "service": 20.0, "living_street": 20.0,
}


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
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgrouting;
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
  min_longitude DOUBLE PRECISION,
  min_latitude DOUBLE PRECISION,
  max_longitude DOUBLE PRECISION,
  max_latitude DOUBLE PRECISION,
  road_name TEXT,
  road_type TEXT,
  length_m NUMERIC,
  max_slope_percent NUMERIC,
  routing_edge_id BIGINT,
  source_node_id BIGINT,
  target_node_id BIGINT,
  source_node_key TEXT,
  target_node_key TEXT,
  routing_oneway BOOLEAN NOT NULL DEFAULT false,
  speed_limit_kmh NUMERIC,
  effective_speed_kmh NUMERIC,
  base_travel_time_s NUMERIC,
  reverse_travel_time_s NUMERIC,
  access_status TEXT NOT NULL DEFAULT 'unknown',
  bridge BOOLEAN NOT NULL DEFAULT false,
  tunnel BOOLEAN NOT NULL DEFAULT false,
  graph_version TEXT,
  source TEXT NOT NULL,
  source_version TEXT,
  snapshot_date DATE NOT NULL,
  is_simulated BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS road_name TEXT;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS min_longitude DOUBLE PRECISION;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS min_latitude DOUBLE PRECISION;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS max_longitude DOUBLE PRECISION;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS max_latitude DOUBLE PRECISION;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS routing_edge_id BIGINT;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS source_node_id BIGINT;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS target_node_id BIGINT;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS source_node_key TEXT;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS target_node_key TEXT;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS routing_oneway BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS speed_limit_kmh NUMERIC;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS effective_speed_kmh NUMERIC;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS base_travel_time_s NUMERIC;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS reverse_travel_time_s NUMERIC;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS access_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS bridge BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS tunnel BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE road_segments ADD COLUMN IF NOT EXISTS graph_version TEXT;
CREATE INDEX IF NOT EXISTS road_segments_bbox_idx
  ON road_segments (min_longitude, max_longitude, min_latitude, max_latitude);
CREATE TABLE IF NOT EXISTS routing_nodes (
  node_id BIGINT PRIMARY KEY,
  source_node_key TEXT UNIQUE NOT NULL,
  geometry geometry(Point, 4326) NOT NULL,
  graph_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS routing_nodes_geometry_idx ON routing_nodes USING GIST (geometry);
CREATE TABLE IF NOT EXISTS routing_edges (
  edge_id BIGINT PRIMARY KEY,
  segment_id TEXT UNIQUE NOT NULL REFERENCES road_segments(segment_id),
  source BIGINT NOT NULL REFERENCES routing_nodes(node_id),
  target BIGINT NOT NULL REFERENCES routing_nodes(node_id),
  geometry geometry(LineString, 4326) NOT NULL,
  length_m NUMERIC NOT NULL CHECK (length_m > 0),
  road_type TEXT,
  speed_limit_kmh NUMERIC,
  effective_speed_kmh NUMERIC NOT NULL CHECK (effective_speed_kmh > 0),
  base_travel_time_s NUMERIC NOT NULL CHECK (base_travel_time_s > 0),
  reverse_travel_time_s NUMERIC,
  oneway BOOLEAN NOT NULL,
  access_status TEXT NOT NULL CHECK (access_status IN ('open', 'closed', 'unknown')),
  bridge BOOLEAN NOT NULL,
  tunnel BOOLEAN NOT NULL,
  max_slope_percent NUMERIC,
  graph_version TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS routing_edges_geometry_idx ON routing_edges USING GIST (geometry);
CREATE INDEX IF NOT EXISTS routing_edges_source_idx ON routing_edges (source);
CREATE INDEX IF NOT EXISTS routing_edges_target_idx ON routing_edges (target);
CREATE INDEX IF NOT EXISTS routing_edges_graph_version_idx ON routing_edges (graph_version);
CREATE TABLE IF NOT EXISTS routing_graph_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  graph_version TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL
);
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
DROP VIEW IF EXISTS road_segments_enriched;
CREATE VIEW road_segments_enriched AS
SELECT r.segment_id, r.geometry_geojson, r.road_name, r.road_type,
       r.length_m, r.max_slope_percent, r.source, r.source_version,
       r.snapshot_date, r.is_simulated,
       s.snow_pipe, s.operation_status, s.effectiveness,
       s.valid_from AS snow_pipe_updated_at, s.source AS snow_pipe_source,
       s.rule_version AS snow_pipe_rule_version,
       s.is_simulated AS snow_pipe_is_simulated,
       r.min_longitude, r.min_latitude, r.max_longitude, r.max_latitude
FROM road_segments r
LEFT JOIN latest_snow_pipe_status s USING (segment_id);
"""

ROAD_STAGE_COLUMNS = """
segment_id, geometry_geojson, min_longitude, min_latitude, max_longitude, max_latitude,
road_name, road_type, length_m, max_slope_percent, routing_edge_id,
source_node_id, target_node_id, source_node_key, target_node_key, routing_oneway,
speed_limit_kmh, effective_speed_kmh, base_travel_time_s, reverse_travel_time_s,
access_status, bridge, tunnel, graph_version, source, source_version, snapshot_date, is_simulated
"""

SNOW_PIPE_STAGE_COLUMNS = """
segment_id, snow_pipe, operation_status, effectiveness, valid_from,
source, rule_version, run_id, is_simulated
"""

BULK_UPSERT_SQL = f"""
INSERT INTO road_segments ({ROAD_STAGE_COLUMNS})
SELECT {ROAD_STAGE_COLUMNS} FROM road_segments_stage
ON CONFLICT (segment_id) DO UPDATE SET
  geometry_geojson = EXCLUDED.geometry_geojson,
  min_longitude = EXCLUDED.min_longitude,
  min_latitude = EXCLUDED.min_latitude,
  max_longitude = EXCLUDED.max_longitude,
  max_latitude = EXCLUDED.max_latitude,
  road_name = EXCLUDED.road_name,
  road_type = EXCLUDED.road_type,
  length_m = EXCLUDED.length_m,
  max_slope_percent = EXCLUDED.max_slope_percent,
  routing_edge_id = EXCLUDED.routing_edge_id,
  source_node_id = EXCLUDED.source_node_id,
  target_node_id = EXCLUDED.target_node_id,
  source_node_key = EXCLUDED.source_node_key,
  target_node_key = EXCLUDED.target_node_key,
  routing_oneway = EXCLUDED.routing_oneway,
  speed_limit_kmh = EXCLUDED.speed_limit_kmh,
  effective_speed_kmh = EXCLUDED.effective_speed_kmh,
  base_travel_time_s = EXCLUDED.base_travel_time_s,
  reverse_travel_time_s = EXCLUDED.reverse_travel_time_s,
  access_status = EXCLUDED.access_status,
  bridge = EXCLUDED.bridge,
  tunnel = EXCLUDED.tunnel,
  graph_version = EXCLUDED.graph_version,
  source = EXCLUDED.source,
  source_version = EXCLUDED.source_version,
  snapshot_date = EXCLUDED.snapshot_date,
  is_simulated = EXCLUDED.is_simulated;

INSERT INTO snow_pipe_history ({SNOW_PIPE_STAGE_COLUMNS})
SELECT {SNOW_PIPE_STAGE_COLUMNS} FROM snow_pipe_history_stage
ON CONFLICT (segment_id, valid_from, rule_version) DO UPDATE SET
  snow_pipe = EXCLUDED.snow_pipe,
  operation_status = EXCLUDED.operation_status,
  effectiveness = EXCLUDED.effectiveness,
  source = EXCLUDED.source,
  run_id = EXCLUDED.run_id,
  is_simulated = EXCLUDED.is_simulated,
  ingested_at = now();

DELETE FROM routing_edges;
DELETE FROM routing_nodes;
INSERT INTO routing_nodes (node_id, source_node_key, geometry, graph_version)
SELECT DISTINCT ON (node_id) node_id, node_key, geometry, graph_version
FROM (
  SELECT source_node_id AS node_id, source_node_key AS node_key,
         ST_StartPoint(ST_GeomFromGeoJSON(geometry_geojson::text)) AS geometry,
         graph_version
  FROM road_segments_stage
  UNION ALL
  SELECT target_node_id, target_node_key,
         ST_EndPoint(ST_GeomFromGeoJSON(geometry_geojson::text)),
         graph_version
  FROM road_segments_stage
) nodes
ORDER BY node_id, node_key;

INSERT INTO routing_edges (
  edge_id, segment_id, source, target, geometry, length_m, road_type,
  speed_limit_kmh, effective_speed_kmh, base_travel_time_s, reverse_travel_time_s,
  oneway, access_status, bridge, tunnel, max_slope_percent, graph_version, is_simulated
)
SELECT routing_edge_id, segment_id, source_node_id, target_node_id,
       ST_GeomFromGeoJSON(geometry_geojson::text), length_m, road_type,
       speed_limit_kmh, effective_speed_kmh, base_travel_time_s, reverse_travel_time_s,
       routing_oneway, access_status, bridge, tunnel, max_slope_percent,
       graph_version, is_simulated
FROM road_segments_stage;

INSERT INTO routing_graph_state (singleton, graph_version, node_count, edge_count)
SELECT true, graph_version,
       (SELECT count(*) FROM routing_nodes),
       (SELECT count(*) FROM routing_edges)
FROM road_segments_stage
LIMIT 1
ON CONFLICT (singleton) DO UPDATE SET
  graph_version = EXCLUDED.graph_version,
  activated_at = now(),
  node_count = EXCLUDED.node_count,
  edge_count = EXCLUDED.edge_count;
"""


def geometry_bounds(geometry: dict[str, Any]) -> tuple[float, float, float, float]:
    points: list[tuple[float, float]] = []

    def collect(value: Any) -> None:
        if (
            isinstance(value, list)
            and len(value) >= 2
            and isinstance(value[0], (int, float))
            and isinstance(value[1], (int, float))
        ):
            points.append((float(value[0]), float(value[1])))
            return
        if isinstance(value, list):
            for child in value:
                collect(child)

    collect(geometry.get("coordinates"))
    if not points:
        raise ValueError("road geometry contains no coordinates")
    longitudes = [point[0] for point in points]
    latitudes = [point[1] for point in points]
    return min(longitudes), min(latitudes), max(longitudes), max(latitudes)


def stable_bigint(value: str) -> int:
    """Build a deterministic positive bigint suitable for pgRouting IDs."""
    return int.from_bytes(hashlib.sha256(value.encode()).digest()[:8], "big") & ((1 << 63) - 1)


def _first_value(value: Any) -> str:
    return str(value or "").split(";")[0].strip().lower()


def speed_limit_kmh(value: Any) -> float | None:
    match = re.search(r"\d+(?:\.\d+)?", _first_value(value))
    if not match:
        return None
    speed = float(match.group())
    return speed if 5 <= speed <= 130 else None


def effective_speed_kmh(road_type: Any, speed_limit: float | None) -> float:
    if speed_limit is not None:
        return speed_limit
    return DEFAULT_SPEED_KMH.get(_first_value(road_type), 30.0)


def access_status(access: Any, service: Any) -> str:
    access_value = _first_value(access)
    service_value = _first_value(service)
    if access_value in {"no", "private", "agricultural", "forestry"}:
        return "closed"
    if access_value in {"yes", "permissive", "destination"}:
        return "open"
    if service_value in {"parking_aisle", "driveway", "alley"}:
        return "unknown"
    return "open" if not access_value else "unknown"


def osm_boolean(value: Any) -> bool:
    return _first_value(value) in {"true", "yes", "1"}


def database_rows(feature_collection: dict[str, Any], processing_run_id: str) -> list[tuple[tuple[Any, ...], tuple[Any, ...]]]:
    rows = []
    for feature in feature_collection.get("features", []):
        properties = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "LineString":
            raise ValueError("routing road geometry must be a LineString")
        source_node_key = properties.get("source_node_key")
        target_node_key = properties.get("target_node_key")
        if not source_node_key or not target_node_key:
            raise ValueError("road feature is missing routing node keys")
        min_longitude, min_latitude, max_longitude, max_latitude = geometry_bounds(geometry)
        segment_id = properties["segment_id"]
        length_m = float(properties.get("length_m") or 0)
        if length_m <= 0:
            raise ValueError("road feature length_m must be greater than zero")
        speed_limit = speed_limit_kmh(properties.get("maxspeed"))
        effective_speed = effective_speed_kmh(properties.get("highway"), speed_limit)
        travel_time = length_m / (effective_speed / 3.6)
        oneway = bool(properties.get("routing_oneway", False))
        road_row = (
            segment_id, json.dumps(geometry, sort_keys=True),
            min_longitude, min_latitude, max_longitude, max_latitude,
            properties.get("road_name", properties.get("name")), properties.get("highway"),
            length_m, properties.get("max_slope_percent"), stable_bigint(f"edge:{segment_id}"),
            stable_bigint(source_node_key), stable_bigint(target_node_key),
            source_node_key, target_node_key, oneway,
            speed_limit, effective_speed, travel_time, None if oneway else travel_time,
            access_status(properties.get("access"), properties.get("service")),
            osm_boolean(properties.get("bridge")), osm_boolean(properties.get("tunnel")),
            processing_run_id, "openstreetmap", properties.get("source_edge_id"),
            properties["snow_pipe_updated_at"][:10], False,
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
            cursor.execute(
                """CREATE TEMP TABLE road_segments_stage
                   (LIKE road_segments INCLUDING DEFAULTS) ON COMMIT DROP;
                   CREATE TEMP TABLE snow_pipe_history_stage
                   (LIKE snow_pipe_history INCLUDING DEFAULTS) ON COMMIT DROP;"""
            )
            with cursor.copy(f"COPY road_segments_stage ({ROAD_STAGE_COLUMNS}) FROM STDIN") as copy:
                for road_row, _ in rows:
                    copy.write_row(road_row)
            with cursor.copy(f"COPY snow_pipe_history_stage ({SNOW_PIPE_STAGE_COLUMNS}) FROM STDIN") as copy:
                for _, snow_row in rows:
                    copy.write_row(snow_row)
            cursor.execute(BULK_UPSERT_SQL)
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
