"""Load S3 JSON Lines weather records into the rebuildable PostgreSQL projection."""

from __future__ import annotations

import json
import os
import sys
from typing import Any


def parse_s3_uri(uri: str) -> tuple[str, str]:
    if not uri.startswith("s3://"):
        raise ValueError("input must be an s3:// URI")
    bucket_and_key = uri.removeprefix("s3://").split("/", 1)
    if len(bucket_and_key) != 2 or not all(bucket_and_key):
        raise ValueError("input must include both bucket and key")
    return bucket_and_key[0], bucket_and_key[1]


def load_weather_records(connection: Any, records: list[dict[str, Any]]) -> int:
    statement = """
        INSERT INTO weather_records (
          weather_record_id, entry_id, title, bulletin_url, data_timestamp,
          content, author, source, source_url, fetched_at, run_id,
          schema_version, is_simulated
        ) VALUES (
          %(weather_record_id)s, %(entry_id)s, %(title)s, %(bulletin_url)s,
          %(data_timestamp)s, %(content)s, %(author)s, %(source)s,
          %(source_url)s, %(fetched_at)s, %(run_id)s, %(schema_version)s,
          %(is_simulated)s
        ) ON CONFLICT (weather_record_id) DO UPDATE SET
          title = EXCLUDED.title,
          bulletin_url = EXCLUDED.bulletin_url,
          data_timestamp = EXCLUDED.data_timestamp,
          content = EXCLUDED.content,
          author = EXCLUDED.author,
          fetched_at = EXCLUDED.fetched_at,
          run_id = EXCLUDED.run_id,
          schema_version = EXCLUDED.schema_version,
          is_simulated = EXCLUDED.is_simulated
    """
    with connection.cursor() as cursor:
        for record in records:
            cursor.execute(statement, record)
    return len(records)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: load_curated.py s3://BUCKET/normalized/.../part-00000.jsonl")
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL must be set")

    bucket, key = parse_s3_uri(sys.argv[1])
    import boto3
    import psycopg

    body = boto3.client("s3").get_object(Bucket=bucket, Key=key)["Body"].read()
    records = [json.loads(line) for line in body.decode().splitlines() if line]
    if not records:
        raise SystemExit("input contains no records")

    with psycopg.connect(database_url) as connection:
        count = load_weather_records(connection, records)
        with connection.cursor() as cursor:
            cursor.execute(
                """INSERT INTO data_load_runs (run_id, dataset, source_key, record_count)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (run_id) DO UPDATE SET record_count = EXCLUDED.record_count""",
                (records[0]["run_id"], "jma-weather-feed", f"s3://{bucket}/{key}", count),
            )
    print(json.dumps({"status": "loaded", "record_count": count, "source": f"s3://{bucket}/{key}"}))


if __name__ == "__main__":
    main()
