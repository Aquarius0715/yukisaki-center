"""Continuously emit three simulated snowplow positions to Kinesis."""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from .route import build_routes, sample_route

LOGGER = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


def _latest_road_object(s3: Any, bucket: str) -> dict[str, Any]:
    response = s3.list_objects_v2(Bucket=bucket, Prefix="curated/road-segments/")
    objects = [item for item in response.get("Contents", []) if item["Key"].endswith(".geojson")]
    if not objects:
        raise RuntimeError("no curated road segment object is available")
    latest = max(objects, key=lambda item: item["LastModified"])
    body = s3.get_object(Bucket=bucket, Key=latest["Key"])["Body"].read()
    return json.loads(body)


def build_event(
    *, run_id: str, vehicle_id: str, observed_at: datetime, position: Any, speed_kmh: float,
) -> dict[str, Any]:
    return {
        "schema_version": "1.0.0",
        "event_id": str(uuid.uuid4()),
        "run_id": run_id,
        "vehicle_id": vehicle_id,
        "observed_at": observed_at.isoformat(),
        "received_at": datetime.now(timezone.utc).isoformat(),
        "latitude": round(position.latitude, 7),
        "longitude": round(position.longitude, 7),
        "speed_kmh": speed_kmh,
        "heading_degrees": round(position.heading_degrees, 2),
        "accuracy_m": 5.0,
        "operation": "snow_removal",
        "ground_truth_segment_id": position.segment_id,
        "source": "yukisaki-gps-simulator",
        "is_simulated": True,
    }


def run_forever() -> None:
    import boto3

    road_bucket = os.environ["ROAD_BUCKET_NAME"]
    stream_name = os.environ["GPS_STREAM_NAME"]
    vehicle_count = int(os.environ.get("VEHICLE_COUNT", "3"))
    interval_seconds = float(os.environ.get("EMIT_INTERVAL_SECONDS", "5"))
    speed_kmh = float(os.environ.get("SPEED_KMH", "18"))
    scenario_start = datetime.fromisoformat(
        os.environ.get("SCENARIO_START_TIME", "2026-01-23T12:00:00+09:00")
    )
    center = (
        float(os.environ.get("TARGET_LONGITUDE", "138.790865")),
        float(os.environ.get("TARGET_LATITUDE", "37.442762")),
    )
    if scenario_start.tzinfo is None or vehicle_count != 3 or interval_seconds <= 0:
        raise ValueError("scenario time, vehicle count, or interval is invalid")
    s3 = boto3.client("s3")
    kinesis = boto3.client("kinesis")
    routes = build_routes(_latest_road_object(s3, road_bucket), center=center, vehicle_count=vehicle_count)
    run_id = f"gps-sim-{uuid.uuid4()}"
    started = time.monotonic()
    route_lengths = [sum(edge.length_m for edge in route) for route in routes]
    LOGGER.info("Starting %d simulated snowplows with run_id=%s", vehicle_count, run_id)
    while True:
        elapsed = time.monotonic() - started
        observed_at = scenario_start + timedelta(seconds=elapsed)
        records = []
        for index, route in enumerate(routes):
            initial_offset = route_lengths[index] * index / vehicle_count
            distance = initial_offset + elapsed * speed_kmh / 3.6
            event = build_event(
                run_id=run_id,
                vehicle_id=f"snowplow-{index + 1:02d}",
                observed_at=observed_at,
                position=sample_route(route, distance),
                speed_kmh=speed_kmh,
            )
            records.append({
                "Data": (json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n").encode(),
                "PartitionKey": event["vehicle_id"],
            })
        response = kinesis.put_records(StreamName=stream_name, Records=records)
        if response.get("FailedRecordCount"):
            raise RuntimeError(f"Kinesis rejected {response['FailedRecordCount']} GPS events")
        LOGGER.info("Emitted %d GPS events at %s", len(records), observed_at.isoformat())
        time.sleep(interval_seconds)


if __name__ == "__main__":
    run_forever()
