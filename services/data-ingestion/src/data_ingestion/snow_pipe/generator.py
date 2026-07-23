"""Generate deterministic simulated snow-pipe records from a road manifest."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote_plus, urlparse

from data_ingestion.common.metadata import build_collection_metadata

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)
RULE_VERSION = "road-name-active-v2"
DATASET = "snow-pipe-simulated"
_S3_CLIENT = None


def s3_client():
    global _S3_CLIENT
    if _S3_CLIENT is None:
        import boto3

        _S3_CLIENT = boto3.client("s3")
    return _S3_CLIENT


def deterministic_run_id(road_run_id: str, rule_version: str, reference_time: str) -> str:
    payload = f"{road_run_id}|{rule_version}|{reference_time}"
    return f"snow-pipe-{hashlib.sha256(payload.encode()).hexdigest()[:24]}"


def road_name_present(value: Any) -> bool:
    if isinstance(value, list):
        return any(str(item).strip() for item in value)
    return value is not None and bool(str(value).strip())


def generate_records(
    feature_collection: dict[str, Any], *, road_run_id: str, reference_time: str,
    rule_version: str = RULE_VERSION,
) -> list[dict[str, Any]]:
    features = feature_collection.get("features")
    if feature_collection.get("type") != "FeatureCollection" or not isinstance(features, list):
        raise ValueError("road data must be a GeoJSON FeatureCollection")
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for feature in features:
        properties = feature.get("properties") or {}
        segment_id = properties.get("segment_id")
        if not segment_id:
            raise ValueError("every road feature must contain segment_id")
        if segment_id in seen:
            raise ValueError(f"duplicate road segment_id: {segment_id}")
        seen.add(segment_id)
        road_name = properties.get("road_name")
        if not road_name_present(road_name):
            road_name = properties.get("name")
        present = road_name_present(road_name)
        records.append({
            "segment_id": segment_id,
            "snow_pipe": present,
            "operation_status": "active" if present else "inactive",
            "effectiveness": 0.8 if present else 0.0,
            "updated_at": reference_time,
            "source": "simulated-road-name-rule",
            "rule_version": rule_version,
            "reason": "road_name_present" if present else "road_name_missing",
            "source_road_run_id": road_run_id,
            "is_simulated": True,
        })
    if not records:
        raise ValueError("road data contains no features")
    return records


def _verified_json(bucket: str, key: str, *, require_metadata_checksum: bool = True) -> tuple[dict[str, Any], str]:
    response = s3_client().get_object(Bucket=bucket, Key=key)
    body = response["Body"].read()
    checksum = hashlib.sha256(body).hexdigest()
    expected = response.get("Metadata", {}).get("sha256")
    if (require_metadata_checksum and not expected) or (expected and expected != checksum):
        raise ValueError(f"S3 checksum is missing or invalid: s3://{bucket}/{key}")
    return json.loads(body), checksum


def _s3_location(uri: str) -> tuple[str, str]:
    parsed = urlparse(uri)
    if parsed.scheme != "s3" or not parsed.netloc or not parsed.path:
        raise ValueError(f"invalid S3 URI: {uri}")
    return parsed.netloc, parsed.path.lstrip("/")


def _manifest_location(event: dict[str, Any]) -> tuple[str, str]:
    if event.get("manifestBucket") and event.get("manifestKey"):
        return event["manifestBucket"], event["manifestKey"]
    detail = event.get("detail") or {}
    bucket = (detail.get("bucket") or {}).get("name")
    key = (detail.get("object") or {}).get("key")
    if not bucket or not key:
        request = detail.get("requestParameters") or {}
        bucket = request.get("bucketName")
        key = request.get("key")
    if not bucket or not key:
        raise ValueError("event does not contain an S3 manifest location")
    return bucket, unquote_plus(key)


def process_manifest(
    bucket: str, manifest_key: str, *, output_bucket: str | None = None,
) -> dict[str, Any]:
    # The already deployed road collector predates manifest object checksums.
    # Its manifest embeds the verified road GeoJSON checksum, and the road
    # object itself has checksum metadata, so only that immutable input is
    # required to carry the S3 metadata checksum.
    manifest, _ = _verified_json(bucket, manifest_key, require_metadata_checksum=False)
    if manifest.get("dataset") != "road-network" or manifest.get("status") != "collected":
        raise ValueError("manifest is not a collected road-network dataset")
    road_run_id = manifest.get("run_id")
    if not road_run_id:
        raise ValueError("road manifest does not contain run_id")
    road_uri = next(
        (value for value in manifest.get("output_keys", []) if value.endswith("/road_segments.geojson")),
        None,
    )
    if not road_uri:
        raise ValueError("road manifest does not reference road_segments.geojson")
    road_bucket, road_key = _s3_location(road_uri)
    roads, road_checksum = _verified_json(road_bucket, road_key)
    if manifest.get("checksum_sha256") != road_checksum:
        raise ValueError("road manifest checksum does not match road_segments.geojson")

    snow_bucket = output_bucket or os.environ["SNOW_DATA_BUCKET_NAME"]
    reference_time = os.environ.get("TARGET_REFERENCE_TIME", "2026-01-23T12:00:00+09:00")
    datetime.fromisoformat(reference_time)
    snow_run_id = deterministic_run_id(road_run_id, RULE_VERSION, reference_time)
    records = generate_records(roads, road_run_id=road_run_id, reference_time=reference_time)
    body = "".join(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in records).encode()
    checksum = hashlib.sha256(body).hexdigest()
    scenario_date = reference_time[:10]
    root = f"raw/simulated/snow-pipe/scenario_date={scenario_date}/run_id={snow_run_id}"
    snow_key = f"{root}/snow_pipe.jsonl"
    metadata_key = f"{root}/metadata.json"
    generated_at = datetime.now(timezone.utc).isoformat()
    metadata = build_collection_metadata(
        run_id=snow_run_id,
        dataset=DATASET,
        source="simulated-road-name-rule",
        source_urls=[road_uri],
        fetched_at=generated_at,
        target_start_at=reference_time,
        target_end_at=reference_time,
        checksum_sha256=checksum,
        is_simulated=True,
        extra={
            "rule_version": RULE_VERSION,
            "source_road_run_id": road_run_id,
            "source_road_checksum_sha256": road_checksum,
            "record_count": len(records),
        },
    )
    metadata_body = (json.dumps(metadata, ensure_ascii=False, sort_keys=True) + "\n").encode()
    s3_client().put_object(
        Bucket=snow_bucket, Key=snow_key, Body=body, ContentType="application/x-ndjson",
        Metadata={"sha256": checksum, "run-id": snow_run_id, "source": "simulated-road-name-rule"},
    )
    s3_client().put_object(
        Bucket=snow_bucket, Key=metadata_key, Body=metadata_body, ContentType="application/json",
        Metadata={"sha256": hashlib.sha256(metadata_body).hexdigest(), "run-id": snow_run_id},
    )
    manifest_output_key = f"manifests/data-ingestion/{snow_run_id}.json"
    output_manifest = {
        **metadata,
        "pipeline": "snow-pipe-simulation",
        "status": "collected",
        "input_keys": [road_uri, f"s3://{bucket}/{manifest_key}"],
        "output_keys": [f"s3://{snow_bucket}/{snow_key}", f"s3://{snow_bucket}/{metadata_key}"],
        "input_count": len(records),
        "output_count": len(records),
    }
    manifest_body = (json.dumps(output_manifest, ensure_ascii=False, sort_keys=True) + "\n").encode()
    s3_client().put_object(
        Bucket=snow_bucket, Key=manifest_output_key, Body=manifest_body, ContentType="application/json",
        Metadata={"sha256": hashlib.sha256(manifest_body).hexdigest(), "run-id": snow_run_id},
    )
    LOGGER.info("Generated %d simulated snow-pipe records for road run %s", len(records), road_run_id)
    return {
        "roadBucket": road_bucket,
        "roadKey": road_key,
        "roadChecksumSha256": road_checksum,
        "roadRunId": road_run_id,
        "snowPipeBucket": snow_bucket,
        "snowPipeKey": snow_key,
        "snowPipeChecksumSha256": checksum,
        "snowPipeRunId": snow_run_id,
        "referenceTime": reference_time,
        "recordCount": len(records),
    }


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    bucket, key = _manifest_location(event)
    return process_manifest(bucket, key)
