"""Normalize an S3 weather window and load it into PostgreSQL."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import unquote_plus
from zoneinfo import ZoneInfo

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)
TIMEZONE_NAME = "Asia/Tokyo"
FIELDS = (
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


def series_by_time(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    hourly = payload["hourly"]
    result: dict[str, dict[str, Any]] = {}
    for index, valid_time in enumerate(hourly["time"]):
        result[valid_time] = {field: hourly[field][index] for field in FIELDS}
    return result


def _location_sources(raw: dict[str, Any]) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    if "locations" in raw:
        result = []
        for item in raw["locations"]:
            if not isinstance(item, dict) or not isinstance(item.get("location"), dict):
                raise ValueError("weather location entry is invalid")
            if not isinstance(item.get("sources"), dict):
                raise ValueError("weather location sources are invalid")
            result.append((item["location"], item["sources"]))
        if not result:
            raise ValueError("weather payload contains no locations")
        return result
    return [(raw["location"], raw["sources"])]


def source_urls(raw: dict[str, Any]) -> list[str]:
    if isinstance(raw.get("source_urls"), list):
        return [str(url) for url in raw["source_urls"]]
    return [raw["sources"]["observation"]["url"], raw["sources"]["forecast"]["url"]]


def normalize_window(raw: dict[str, Any]) -> list[dict[str, Any]]:
    reference = datetime.fromisoformat(raw["reference_time"]).astimezone(ZoneInfo(TIMEZONE_NAME))
    records: list[dict[str, Any]] = []
    for location, sources in _location_sources(raw):
        observation = series_by_time(sources["observation"]["response"])
        forecast = series_by_time(sources["forecast"]["response"])
        for relative_hour in range(-3, 4):
            valid_at = reference + timedelta(hours=relative_hour)
            key = valid_at.strftime("%Y-%m-%dT%H:00")
            data_kind = "observed" if relative_hour <= 0 else "forecast"
            source = observation if data_kind == "observed" else forecast
            if key not in source:
                raise ValueError(f"source does not contain required hour {key}")
            values = source[key]
            record_id_source = (
                f"{location['location_id']}|{reference.isoformat()}|{valid_at.isoformat()}|{data_kind}"
            )
            records.append(
                {
                    "weather_window_record_id": hashlib.sha256(record_id_source.encode()).hexdigest(),
                    "location_id": location["location_id"],
                    "location_name": location["name"],
                    "latitude": location["latitude"],
                    "longitude": location["longitude"],
                    "reference_time": reference.isoformat(),
                    "valid_time": valid_at.isoformat(),
                    "relative_hour": relative_hour,
                    "data_kind": data_kind,
                    "temperature_c": values["temperature_2m"],
                    "relative_humidity_percent": values["relative_humidity_2m"],
                    "precipitation_mm": values["precipitation"],
                    "snowfall_cm": values["snowfall"],
                    "snow_depth_m": values["snow_depth"],
                    "weather_code": values["weather_code"],
                    "wind_speed_kmh": values["wind_speed_10m"],
                    "wind_gusts_kmh": values["wind_gusts_10m"],
                    "source": "open-meteo-historical-weather"
                    if data_kind == "observed"
                    else "open-meteo-historical-forecast",
                    "source_url": sources[
                        "observation" if data_kind == "observed" else "forecast"
                    ]["url"],
                    "fetched_at": raw["fetched_at"],
                    "run_id": raw["run_id"],
                    "schema_version": raw["schema_version"],
                    "is_simulated": False,
                }
            )
    return records


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS data_load_runs (
  run_id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  source_key TEXT NOT NULL,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  record_count INTEGER NOT NULL CHECK (record_count >= 0)
);
CREATE TABLE IF NOT EXISTS weather_hourly_windows (
  weather_window_record_id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  location_name TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  reference_time TIMESTAMPTZ NOT NULL,
  valid_time TIMESTAMPTZ NOT NULL,
  relative_hour SMALLINT NOT NULL CHECK (relative_hour BETWEEN -3 AND 3),
  data_kind TEXT NOT NULL CHECK (data_kind IN ('observed', 'forecast')),
  temperature_c NUMERIC,
  relative_humidity_percent NUMERIC,
  precipitation_mm NUMERIC,
  snowfall_cm NUMERIC,
  snow_depth_m NUMERIC,
  weather_code INTEGER,
  wind_speed_kmh NUMERIC,
  wind_gusts_kmh NUMERIC,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  run_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (location_id, reference_time, valid_time, data_kind)
);
CREATE INDEX IF NOT EXISTS weather_hourly_windows_lookup_idx
  ON weather_hourly_windows (location_id, reference_time, relative_hour);
"""

UPSERT_SQL = """
INSERT INTO weather_hourly_windows (
  weather_window_record_id, location_id, location_name, latitude, longitude,
  reference_time, valid_time, relative_hour, data_kind, temperature_c,
  relative_humidity_percent, precipitation_mm, snowfall_cm, snow_depth_m,
  weather_code, wind_speed_kmh, wind_gusts_kmh, source, source_url,
  fetched_at, run_id, schema_version, is_simulated
) VALUES (
  %(weather_window_record_id)s, %(location_id)s, %(location_name)s, %(latitude)s,
  %(longitude)s, %(reference_time)s, %(valid_time)s, %(relative_hour)s,
  %(data_kind)s, %(temperature_c)s, %(relative_humidity_percent)s,
  %(precipitation_mm)s, %(snowfall_cm)s, %(snow_depth_m)s, %(weather_code)s,
  %(wind_speed_kmh)s, %(wind_gusts_kmh)s, %(source)s, %(source_url)s,
  %(fetched_at)s, %(run_id)s, %(schema_version)s, %(is_simulated)s
) ON CONFLICT (weather_window_record_id) DO UPDATE SET
  temperature_c = EXCLUDED.temperature_c,
  relative_humidity_percent = EXCLUDED.relative_humidity_percent,
  precipitation_mm = EXCLUDED.precipitation_mm,
  snowfall_cm = EXCLUDED.snowfall_cm,
  snow_depth_m = EXCLUDED.snow_depth_m,
  weather_code = EXCLUDED.weather_code,
  wind_speed_kmh = EXCLUDED.wind_speed_kmh,
  wind_gusts_kmh = EXCLUDED.wind_gusts_kmh,
  fetched_at = EXCLUDED.fetched_at,
  run_id = EXCLUDED.run_id,
  schema_version = EXCLUDED.schema_version;
"""


def connect_database():
    import psycopg

    secret = database_secret()
    return psycopg.connect(
        host=secret["host"],
        port=secret.get("port", 5432),
        dbname=secret.get("dbname", os.environ.get("DATABASE_NAME", "yukisaki")),
        user=secret["username"],
        password=secret["password"],
        sslmode="require",
        connect_timeout=10,
    )


def put_json(bucket: str, key: str, value: dict[str, Any]) -> None:
    s3_client().put_object(
        Bucket=bucket,
        Key=key,
        Body=(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode(),
        ContentType="application/json",
    )


def parse_verified_raw(source_object: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """Verify the immutable S3 raw checksum before parsing its JSON body."""
    source_body = source_object["Body"].read()
    source_checksum = hashlib.sha256(source_body).hexdigest()
    expected_checksum = source_object.get("Metadata", {}).get("sha256")
    if not expected_checksum or expected_checksum != source_checksum:
        raise ValueError("S3 raw weather checksum is missing or does not match the object body")
    return json.loads(source_body), source_checksum


def snapshot_scope(records: list[dict[str, Any]]) -> tuple[str, list[str]]:
    reference_times = {record["reference_time"] for record in records}
    if len(reference_times) != 1:
        raise ValueError("weather snapshot records must share one reference_time")
    location_ids = sorted({record["location_id"] for record in records})
    if not location_ids:
        raise ValueError("weather snapshot contains no locations")
    return reference_times.pop(), location_ids


def process_object(bucket: str, key: str) -> dict[str, Any]:
    source_object = s3_client().get_object(Bucket=bucket, Key=key)
    raw, source_checksum = parse_verified_raw(source_object)
    records = normalize_window(raw)
    reference_time, location_ids = snapshot_scope(records)
    reference_date = records[0]["reference_time"][:10]
    run_id = raw["run_id"]
    output_key = (
        "normalized/open-meteo/weather-window/"
        f"reference_date={reference_date}/run_id={run_id}/part-00000.jsonl"
    )
    body = "".join(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in records).encode()
    s3_client().put_object(
        Bucket=bucket,
        Key=output_key,
        Body=body,
        ContentType="application/x-ndjson",
        Metadata={"run-id": run_id, "sha256": hashlib.sha256(body).hexdigest()},
    )
    with connect_database() as connection:
        with connection.cursor() as cursor:
            cursor.execute(SCHEMA_SQL)
            for record in records:
                cursor.execute(UPSERT_SQL, record)
            cursor.execute(
                """DELETE FROM weather_hourly_windows
                   WHERE reference_time = %s::timestamptz
                     AND NOT (location_id = ANY(%s))""",
                (reference_time, location_ids),
            )
            cursor.execute(
                """INSERT INTO data_load_runs (run_id, dataset, source_key, record_count)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (run_id) DO UPDATE SET
                     source_key = EXCLUDED.source_key,
                     record_count = EXCLUDED.record_count,
                     loaded_at = now()""",
                (run_id, "weather-hourly-window", f"s3://{bucket}/{key}", len(records)),
            )
    put_json(
        bucket,
        f"manifests/data-processing/{run_id}.json",
        {
            "metadata_schema_version": "1.0.0",
            "run_id": run_id,
            "pipeline": "weather-window-processing",
            "dataset": "weather-hourly-window",
            "source": "open-meteo",
            "source_urls": source_urls(raw),
            "fetched_at": raw["fetched_at"],
            "target_start_at": raw["window_start"],
            "target_end_at": raw["window_end"],
            "checksum_sha256": source_checksum,
            "status": "succeeded",
            "input_keys": [f"s3://{bucket}/{key}"],
            "output_keys": [f"s3://{bucket}/{output_key}"],
            "output_count": len(records),
            "database_table": "weather_hourly_windows",
            "is_simulated": False,
        },
    )
    return {"runId": run_id, "outputKey": output_key, "recordCount": len(records)}


def database_status() -> dict[str, Any]:
    with connect_database() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT to_regclass('public.weather_hourly_windows')")
            if cursor.fetchone()[0] is None:
                return {"table": "weather_hourly_windows", "recordCount": 0, "records": []}
            cursor.execute(
                """SELECT location_id, location_name, relative_hour, data_kind, valid_time::text,
                          temperature_c::double precision, precipitation_mm::double precision,
                          snowfall_cm::double precision, snow_depth_m::double precision,
                          weather_code
                   FROM weather_hourly_windows
                   WHERE reference_time = %s::timestamptz
                   ORDER BY location_id, relative_hour""",
                (os.environ.get("TARGET_REFERENCE_TIME", "2026-01-23T12:00:00+09:00"),),
            )
            rows = cursor.fetchall()
    return {
        "table": "weather_hourly_windows",
        "recordCount": len(rows),
        "records": [
            {
                "locationId": row[0],
                "locationName": row[1],
                "relativeHour": row[2],
                "dataKind": row[3],
                "validTime": row[4],
                "temperatureC": row[5],
                "precipitationMm": row[6],
                "snowfallCm": row[7],
                "snowDepthM": row[8],
                "weatherCode": row[9],
            }
            for row in rows
        ],
    }


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    if event.get("action") == "status":
        return database_status()
    results = []
    for item in event.get("Records", []):
        if item.get("eventSource") != "aws:s3":
            continue
        bucket = item["s3"]["bucket"]["name"]
        key = unquote_plus(item["s3"]["object"]["key"])
        if key.startswith("raw/open-meteo/weather-window/") and key.endswith("/response.json"):
            results.append(process_object(bucket, key))
    if not results:
        raise ValueError("event contains no supported weather window records")
    return {"status": "loaded", "results": results}
