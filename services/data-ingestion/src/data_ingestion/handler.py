"""Scheduled HTTPS collector for a JMA XML feed."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import socket
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

_S3_CLIENT = None


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def validate_source_url(source_url: str, allowed_hosts: set[str]) -> None:
    parsed = urlparse(source_url)
    if parsed.scheme != "https":
        raise ValueError("SOURCE_URL must use HTTPS")
    if not parsed.hostname or parsed.hostname not in allowed_hosts:
        raise ValueError("SOURCE_URL host is not allow-listed")
    if parsed.username or parsed.password:
        raise ValueError("SOURCE_URL must not contain credentials")


def read_limited_response(response: Any, maximum_bytes: int) -> bytes:
    body = response.read(maximum_bytes + 1)
    if len(body) > maximum_bytes:
        raise ValueError(f"response exceeds MAX_RESPONSE_BYTES ({maximum_bytes})")
    if not body:
        raise ValueError("source returned an empty response")
    return body


def make_run_id(event: dict[str, Any]) -> str:
    execution_id = str(event.get("executionId", "")).strip()
    if execution_id:
        return execution_id.replace("/", "_")[:128]
    return str(uuid.uuid4())


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


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    started_at = utc_now()
    run_id = make_run_id(event)
    bucket = os.environ["DATA_BUCKET"]
    dataset = os.environ.get("DATASET", "jma-weather-feed")
    source_url = os.environ["SOURCE_URL"]
    allowed_hosts = {
        host.strip()
        for host in os.environ["ALLOWED_SOURCE_HOSTS"].split(",")
        if host.strip()
    }
    maximum_bytes = int(os.environ.get("MAX_RESPONSE_BYTES", str(10 * 1024 * 1024)))
    validate_source_url(source_url, allowed_hosts)

    ingest_date = started_at.date().isoformat()
    raw_prefix = (
        f"raw/jma/weather-feed/ingest_date={ingest_date}/run_id={run_id}"
    )
    manifest_key = f"manifests/data-ingestion/{run_id}.json"

    request = Request(
        source_url,
        headers={
            "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.1",
            "User-Agent": os.environ.get("USER_AGENT", "yukisaki-center/0.1"),
        },
        method="GET",
    )

    try:
        with urlopen(request, timeout=15) as response:
            body = read_limited_response(response, maximum_bytes)
            status = getattr(response, "status", 200)
            headers = response.headers

        checksum = hashlib.sha256(body).hexdigest()
        raw_key = f"{raw_prefix}/response.xml"
        metadata_key = f"{raw_prefix}/metadata.json"
        s3_client().put_object(
            Bucket=bucket,
            Key=raw_key,
            Body=body,
            ContentType=headers.get_content_type() or "application/xml",
            Metadata={
                "sha256": checksum,
                "run-id": run_id,
                "source": "jma",
            },
        )
        metadata = {
            "schema_version": "1.0.0",
            "source": "jma",
            "source_url": source_url,
            "fetched_at": started_at.isoformat(),
            "run_id": run_id,
            "checksum_sha256": checksum,
            "http_status": status,
            "content_type": headers.get("Content-Type"),
            "etag": headers.get("ETag"),
            "last_modified": headers.get("Last-Modified"),
            "content_length": len(body),
            "is_simulated": False,
        }
        put_json(bucket, metadata_key, metadata)

        finished_at = utc_now()
        manifest = {
            "run_id": run_id,
            "pipeline": "data-ingestion",
            "dataset": dataset,
            "schema_version": "1.0.0",
            "status": "collected",
            "started_at": started_at.isoformat(),
            "finished_at": finished_at.isoformat(),
            "input_keys": [source_url],
            "output_keys": [
                f"s3://{bucket}/{raw_key}",
                f"s3://{bucket}/{metadata_key}",
            ],
            "input_count": 1,
            "output_count": 1,
            "checksum_sha256": checksum,
        }
        put_json(bucket, manifest_key, manifest)
        LOGGER.info(
            json.dumps(
                {
                    "event": "collection_succeeded",
                    "pipeline": "data-ingestion",
                    "run_id": run_id,
                    "record_count": 1,
                    "duration_ms": int((finished_at - started_at).total_seconds() * 1000),
                }
            )
        )
        return {"status": "collected", "runId": run_id, "rawKey": raw_key}
    except (HTTPError, URLError, TimeoutError, socket.timeout, ValueError) as error:
        finished_at = utc_now()
        LOGGER.exception(
            json.dumps(
                {
                    "event": "collection_failed",
                    "pipeline": "data-ingestion",
                    "run_id": run_id,
                    "error_type": type(error).__name__,
                    "duration_ms": int((finished_at - started_at).total_seconds() * 1000),
                }
            )
        )
        raise
