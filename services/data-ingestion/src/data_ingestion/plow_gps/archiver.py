"""Validate queued EventBridge GPS events and preserve immutable JSON Lines in S3 raw."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

from data_ingestion.common.metadata import build_collection_metadata, sha256_bytes

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)
_S3_CLIENT = None


def s3_client():
    global _S3_CLIENT
    if _S3_CLIENT is None:
        import boto3

        _S3_CLIENT = boto3.client("s3")
    return _S3_CLIENT


def validate_event(event: dict[str, Any]) -> None:
    required = {
        "schema_version", "event_id", "run_id", "vehicle_id", "observed_at", "received_at",
        "latitude", "longitude", "speed_kmh", "heading_degrees", "accuracy_m", "operation",
        "ground_truth_segment_id", "source", "is_simulated",
    }
    missing = sorted(required - event.keys())
    if missing:
        raise ValueError(f"GPS event is missing fields: {', '.join(missing)}")
    if event["is_simulated"] is not True:
        raise ValueError("MVP GPS events must have is_simulated=true")
    if not -90 <= float(event["latitude"]) <= 90 or not -180 <= float(event["longitude"]) <= 180:
        raise ValueError("GPS coordinates are invalid")
    if event["operation"] not in {"snow_removal", "deicing", "moving"}:
        raise ValueError("GPS operation is invalid")
    for field in ("observed_at", "received_at"):
        value = datetime.fromisoformat(event[field])
        if value.tzinfo is None:
            raise ValueError(f"{field} must include a timezone")


def decode_eventbridge_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events = []
    for record in records:
        try:
            envelope = json.loads(record["body"])
            event = envelope["detail"]
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise ValueError("invalid queued EventBridge GPS record") from error
        validate_event(event)
        events.append(event)
    if not events:
        raise ValueError("SQS batch contains no GPS events")
    return events


def archive_events(events: list[dict[str, Any]], *, bucket: str, event_bus_name: str) -> dict[str, Any]:
    for event in events:
        validate_event(event)
    events = sorted(events, key=lambda item: (item["observed_at"], item["vehicle_id"], item["event_id"]))
    body = b"".join(
        (json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n").encode() for event in events
    )
    checksum = sha256_bytes(body)
    run_seed = "|".join(event["event_id"] for event in events)
    archive_run_id = f"gps-archive-{hashlib.sha256(run_seed.encode()).hexdigest()[:24]}"
    observed = [datetime.fromisoformat(event["observed_at"]) for event in events]
    first = min(observed)
    last = max(observed)
    key = (
        f"raw/simulated/plow-gps/event_date={first.date().isoformat()}/hour={first.hour:02d}/"
        f"run_id={archive_run_id}/events.jsonl"
    )
    fetched_at = datetime.now(timezone.utc).isoformat()
    metadata = build_collection_metadata(
        run_id=archive_run_id,
        dataset="simulated-plow-gps",
        source="yukisaki-gps-simulator",
        source_urls=[f"eventbridge://{event_bus_name}"],
        fetched_at=fetched_at,
        target_start_at=first.isoformat(),
        target_end_at=last.isoformat(),
        checksum_sha256=checksum,
        is_simulated=True,
        extra={"record_count": len(events), "vehicle_ids": sorted({e["vehicle_id"] for e in events})},
    )
    s3_client().put_object(
        Bucket=bucket, Key=key, Body=body, ContentType="application/x-ndjson",
        Metadata={"sha256": checksum, "run-id": archive_run_id},
    )
    manifest_key = f"manifests/data-ingestion/{archive_run_id}.json"
    manifest_body = (json.dumps({
        **metadata,
        "status": "succeeded",
        "output_keys": [f"s3://{bucket}/{key}"],
        "output_count": len(events),
    }, ensure_ascii=False, sort_keys=True) + "\n").encode()
    s3_client().put_object(
        Bucket=bucket, Key=manifest_key, Body=manifest_body, ContentType="application/json",
        Metadata={"sha256": sha256_bytes(manifest_body), "run-id": archive_run_id},
    )
    LOGGER.info("Archived %d simulated GPS events to s3://%s/%s", len(events), bucket, key)
    return {"runId": archive_run_id, "recordCount": len(events), "key": key}


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    events = decode_eventbridge_records(event.get("Records", []))
    return archive_events(
        events,
        bucket=os.environ["DATA_BUCKET"],
        event_bus_name=os.environ["GPS_EVENT_BUS_NAME"],
    )
