"""S3-triggered processor that normalizes the JMA Atom feed."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote_plus
from xml.etree import ElementTree

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

ATOM = "{http://www.w3.org/2005/Atom}"
_S3_CLIENT = None


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def text_of(element: ElementTree.Element, child_name: str) -> str | None:
    child = element.find(f"{ATOM}{child_name}")
    if child is None or child.text is None:
        return None
    value = child.text.strip()
    return value or None


def normalize_atom_feed(
    xml_body: bytes, *, fetched_at: str, run_id: str, schema_version: str
) -> list[dict[str, Any]]:
    root = ElementTree.fromstring(xml_body)
    if root.tag != f"{ATOM}feed":
        raise ValueError(f"expected Atom feed root, got {root.tag}")

    records: list[dict[str, Any]] = []
    for entry in root.findall(f"{ATOM}entry"):
        entry_id = text_of(entry, "id")
        updated = text_of(entry, "updated")
        title = text_of(entry, "title")
        link_element = entry.find(f"{ATOM}link")
        link = link_element.get("href") if link_element is not None else None
        if not entry_id or not updated or not link:
            raise ValueError("Atom entry is missing id, updated, or link")
        records.append(
            {
                "weather_record_id": hashlib.sha256(entry_id.encode()).hexdigest(),
                "entry_id": entry_id,
                "title": title,
                "bulletin_url": link,
                "data_timestamp": updated,
                "content": text_of(entry, "content"),
                "author": text_of(entry, "author"),
                "source": "jma",
                "source_url": link,
                "fetched_at": fetched_at,
                "run_id": run_id,
                "schema_version": schema_version,
                "is_simulated": False,
            }
        )
    if not records:
        raise ValueError("Atom feed contains no entries")
    return records


def run_id_from_key(key: str) -> str:
    for part in key.split("/"):
        if part.startswith("run_id="):
            value = part.removeprefix("run_id=")
            if value:
                return value
    raise ValueError("raw object key does not contain run_id")


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


def process_record(bucket: str, key: str) -> dict[str, Any]:
    started_at = utc_now()
    run_id = run_id_from_key(key)
    schema_version = os.environ.get("SCHEMA_VERSION", "1.0.0")
    response = s3_client().get_object(Bucket=bucket, Key=key)
    xml_body = response["Body"].read()
    fetched_at = (
        response.get("LastModified", started_at).astimezone(timezone.utc).isoformat()
    )

    try:
        records = normalize_atom_feed(
            xml_body,
            fetched_at=fetched_at,
            run_id=run_id,
            schema_version=schema_version,
        )
        event_date = records[0]["data_timestamp"][:10]
        output_key = (
            "normalized/jma-weather-feed/"
            f"event_date={event_date}/run_id={run_id}/part-00000.jsonl"
        )
        json_lines = "".join(
            json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n"
            for record in records
        ).encode()
        checksum = hashlib.sha256(json_lines).hexdigest()
        s3_client().put_object(
            Bucket=bucket,
            Key=output_key,
            Body=json_lines,
            ContentType="application/x-ndjson",
            Metadata={"sha256": checksum, "run-id": run_id},
        )
        finished_at = utc_now()
        manifest_key = f"manifests/data-processing/{run_id}.json"
        put_json(
            bucket,
            manifest_key,
            {
                "run_id": run_id,
                "pipeline": "data-processing",
                "schema_version": schema_version,
                "status": "succeeded",
                "started_at": started_at.isoformat(),
                "finished_at": finished_at.isoformat(),
                "input_keys": [f"s3://{bucket}/{key}"],
                "output_keys": [f"s3://{bucket}/{output_key}"],
                "input_count": 1,
                "output_count": len(records),
                "quarantine_count": 0,
                "checksum_sha256": checksum,
            },
        )
        LOGGER.info(
            json.dumps(
                {
                    "event": "normalization_succeeded",
                    "pipeline": "data-processing",
                    "run_id": run_id,
                    "record_count": len(records),
                    "duration_ms": int((finished_at - started_at).total_seconds() * 1000),
                }
            )
        )
        return {"runId": run_id, "outputKey": output_key, "recordCount": len(records)}
    except (ElementTree.ParseError, ValueError) as error:
        quarantine_key = (
            "quarantine/jma/weather-feed/"
            f"ingest_date={started_at.date().isoformat()}/run_id={run_id}/error.json"
        )
        put_json(
            bucket,
            quarantine_key,
            {
                "run_id": run_id,
                "input_key": f"s3://{bucket}/{key}",
                "error_type": type(error).__name__,
                "error_message": str(error),
                "failed_at": started_at.isoformat(),
            },
        )
        LOGGER.exception(
            json.dumps(
                {
                    "event": "normalization_failed",
                    "pipeline": "data-processing",
                    "run_id": run_id,
                    "error_type": type(error).__name__,
                }
            )
        )
        raise


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    results = []
    for record in event.get("Records", []):
        if record.get("eventSource") != "aws:s3":
            continue
        bucket = record["s3"]["bucket"]["name"]
        key = unquote_plus(record["s3"]["object"]["key"])
        if not key.endswith("/response.xml"):
            continue
        results.append(process_record(bucket, key))
    if not results:
        raise ValueError("event contains no supported S3 records")
    return {"status": "normalized", "results": results}
