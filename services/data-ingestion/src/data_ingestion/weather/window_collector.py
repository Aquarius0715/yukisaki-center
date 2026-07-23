"""Collect a fixed historical observation/forecast window into immutable S3 raw storage."""

from __future__ import annotations

import json
import logging
import os
import socket
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from data_ingestion.common.metadata import build_collection_metadata, sha256_bytes

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

DEFAULT_REFERENCE_TIME = "2026-01-23T12:00:00+09:00"
DEFAULT_LATITUDE = 37.442762
DEFAULT_LONGITUDE = 138.790865
DEFAULT_LOCATION_ID = "nagaoka-isuruginami-minami"
DEFAULT_LOCATION_NAME = "新潟県長岡市石動南町"
NAGAOKA_BBOX = (138.643056, 37.176389, 139.124444, 37.710278)
NAGAOKA_GRID_COLUMNS = 5
NAGAOKA_GRID_ROWS = 7
TIMEZONE_NAME = "Asia/Tokyo"
OBSERVATION_BASE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_BASE_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
ALLOWED_HOSTS = {
    "archive-api.open-meteo.com",
    "historical-forecast-api.open-meteo.com",
}
HOURLY_FIELDS = (
    "temperature_2m",
    "relative_humidity_2m",
    "precipitation",
    "snowfall",
    "snow_depth",
    "weather_code",
    "wind_speed_10m",
    "wind_gusts_10m",
)

_S3_CLIENT = None


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_reference_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("reference time must include a UTC offset")
    local = parsed.astimezone(ZoneInfo(TIMEZONE_NAME))
    if local.minute != 0 or local.second != 0 or local.microsecond != 0:
        raise ValueError("reference time must be aligned to an hour")
    return local


def build_nagaoka_weather_grid() -> list[dict[str, Any]]:
    """Return an approximately 9 km grid whose extent contains all of Nagaoka City."""
    west, south, east, north = NAGAOKA_BBOX
    longitude_step = (east - west) / NAGAOKA_GRID_COLUMNS
    latitude_step = (north - south) / NAGAOKA_GRID_ROWS
    locations: list[dict[str, Any]] = []
    for row in range(NAGAOKA_GRID_ROWS):
        for column in range(NAGAOKA_GRID_COLUMNS):
            latitude = south + (row + 0.5) * latitude_step
            longitude = west + (column + 0.5) * longitude_step
            grid_id = f"r{row + 1:02d}-c{column + 1:02d}"
            locations.append(
                {
                    "location_id": f"nagaoka-grid-{grid_id}",
                    "name": f"新潟県長岡市 気象グリッド {grid_id.upper()}",
                    "latitude": round(latitude, 6),
                    "longitude": round(longitude, 6),
                    "timezone": TIMEZONE_NAME,
                }
            )
    return locations


def _coordinate_parameter(value: float | list[float]) -> str | float:
    if isinstance(value, list):
        return ",".join(f"{coordinate:.6f}" for coordinate in value)
    return value


def build_source_url(
    base_url: str,
    reference_time: datetime,
    latitude: float | list[float],
    longitude: float | list[float],
) -> str:
    parsed = urlparse(base_url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError("weather source URL is not allow-listed HTTPS")
    query = urlencode(
        {
            "latitude": _coordinate_parameter(latitude),
            "longitude": _coordinate_parameter(longitude),
            "start_date": reference_time.date().isoformat(),
            "end_date": reference_time.date().isoformat(),
            "hourly": ",".join(HOURLY_FIELDS),
            "timezone": TIMEZONE_NAME,
        }
    )
    return f"{base_url}?{query}"


def _validate_weather_response(payload: Any) -> None:
    responses = payload if isinstance(payload, list) else [payload]
    if not responses or not all(isinstance(response, dict) for response in responses):
        raise ValueError("weather API response must contain one or more locations")
    for response in responses:
        hourly = response.get("hourly", {})
        if not isinstance(hourly.get("time"), list):
            raise ValueError("weather API response does not contain hourly time series")
        for field in HOURLY_FIELDS:
            if len(hourly.get(field, [])) != len(hourly["time"]):
                raise ValueError(f"weather API response has an invalid {field} series")


def fetch_json(url: str, opener: Callable[..., Any] = urlopen) -> dict[str, Any] | list[dict[str, Any]]:
    request = Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "yukisaki-center/0.2"},
        method="GET",
    )
    with opener(request, timeout=30) as response:
        body = response.read(5 * 1024 * 1024 + 1)
    if not body or len(body) > 5 * 1024 * 1024:
        raise ValueError("weather API response is empty or too large")
    payload = json.loads(body)
    _validate_weather_response(payload)
    return payload


def s3_client():
    global _S3_CLIENT
    if _S3_CLIENT is None:
        import boto3

        _S3_CLIENT = boto3.client("s3")
    return _S3_CLIENT


def put_json(bucket: str, key: str, value: dict[str, Any]) -> None:
    s3_client().put_object(
        Bucket=bucket,
        Key=key,
        Body=(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode(),
        ContentType="application/json",
    )


def collect(event: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now()
    bucket = os.environ["DATA_BUCKET"]
    reference_time = parse_reference_time(
        str(event.get("referenceTime") or os.environ.get("TARGET_REFERENCE_TIME", DEFAULT_REFERENCE_TIME))
    )
    weather_scope = os.environ.get("WEATHER_SCOPE", "nagaoka-city-grid")
    if weather_scope == "point":
        locations = [
            {
                "location_id": DEFAULT_LOCATION_ID,
                "name": DEFAULT_LOCATION_NAME,
                "latitude": float(os.environ.get("TARGET_LATITUDE", DEFAULT_LATITUDE)),
                "longitude": float(os.environ.get("TARGET_LONGITUDE", DEFAULT_LONGITUDE)),
                "timezone": TIMEZONE_NAME,
            }
        ]
    elif weather_scope == "nagaoka-city-grid":
        locations = build_nagaoka_weather_grid()
    else:
        raise ValueError(f"unsupported WEATHER_SCOPE: {weather_scope}")
    run_id = str(event.get("executionId") or uuid.uuid4()).replace("/", "_")[:128]

    latitudes = [location["latitude"] for location in locations]
    longitudes = [location["longitude"] for location in locations]
    observation_url = build_source_url(OBSERVATION_BASE_URL, reference_time, latitudes, longitudes)
    forecast_url = build_source_url(FORECAST_BASE_URL, reference_time, latitudes, longitudes)
    observation_payload = fetch_json(observation_url)
    forecast_payload = fetch_json(forecast_url)
    observations = observation_payload if isinstance(observation_payload, list) else [observation_payload]
    forecasts = forecast_payload if isinstance(forecast_payload, list) else [forecast_payload]
    if len(observations) != len(locations) or len(forecasts) != len(locations):
        raise ValueError("weather API location count does not match the requested grid")
    payload = {
        "schema_version": "3.0.0",
        "dataset": "weather-hourly-window",
        "target_area": {
            "area_id": "nagaoka-city",
            "name": "新潟県長岡市",
            "bbox": list(NAGAOKA_BBOX),
            "sampling": "regular-grid",
            "grid_columns": NAGAOKA_GRID_COLUMNS,
            "grid_rows": NAGAOKA_GRID_ROWS,
        },
        "locations": [
            {
                "location": location,
                "sources": {
                    "observation": {"url": observation_url, "response": observations[index]},
                    "forecast": {"url": forecast_url, "response": forecasts[index]},
                },
            }
            for index, location in enumerate(locations)
        ],
        "reference_time": reference_time.isoformat(),
        "window_start": (reference_time - timedelta(hours=3)).isoformat(),
        "window_end": (reference_time + timedelta(hours=3)).isoformat(),
        "fetched_at": started_at.isoformat(),
        "run_id": run_id,
        "is_simulated": False,
        "source_urls": [observation_url, forecast_url],
    }
    body = (json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n").encode()
    checksum = sha256_bytes(body)
    target_start_at = (reference_time - timedelta(hours=3)).isoformat()
    target_end_at = (reference_time + timedelta(hours=3)).isoformat()
    collection_metadata = build_collection_metadata(
        run_id=run_id,
        dataset="weather-hourly-window",
        source="open-meteo",
        source_urls=[observation_url, forecast_url],
        fetched_at=started_at.isoformat(),
        target_start_at=target_start_at,
        target_end_at=target_end_at,
        checksum_sha256=checksum,
        is_simulated=False,
    )
    raw_prefix = (
        "raw/open-meteo/weather-window/"
        f"event_date={reference_time.date().isoformat()}/run_id={run_id}"
    )
    raw_key = f"{raw_prefix}/response.json"
    metadata_key = f"{raw_prefix}/metadata.json"
    s3_client().put_object(
        Bucket=bucket,
        Key=raw_key,
        Body=body,
        ContentType="application/json",
        Metadata={"sha256": checksum, "run-id": run_id},
    )
    put_json(
        bucket,
        metadata_key,
        {
            **collection_metadata,
            "schema_version": "3.0.0",
            "reference_time": reference_time.isoformat(),
            "target_area": "新潟県長岡市",
            "location_count": len(locations),
        },
    )
    put_json(
        bucket,
        f"manifests/data-ingestion/{run_id}.json",
        {
            **collection_metadata,
            "pipeline": "weather-window-ingestion",
            "status": "collected",
            "started_at": started_at.isoformat(),
            "finished_at": utc_now().isoformat(),
            "input_keys": [observation_url, forecast_url],
            "output_keys": [f"s3://{bucket}/{raw_key}", f"s3://{bucket}/{metadata_key}"],
            "output_count": len(locations),
        },
    )
    return {
        "status": "collected",
        "runId": run_id,
        "rawKey": raw_key,
        "targetArea": "新潟県長岡市",
        "locationCount": len(locations),
    }


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    try:
        return collect(event)
    except (HTTPError, URLError, TimeoutError, socket.timeout, ValueError, json.JSONDecodeError):
        LOGGER.exception("weather window collection failed")
        raise
