"""Optional upload to the dedicated road-data S3 bucket."""
from __future__ import annotations

import logging
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError

LOGGER = logging.getLogger(__name__)


def upload_outputs(
    geojson: Path, attributes: Path, metadata: Path, bucket: str, dataset: str, run_id: str,
    profile: str | None, region: str, now: datetime | None = None,
) -> dict[str, str]:
    """Upload immutable raw outputs and a service-wide collection manifest."""
    if not bucket:
        raise ValueError("ROAD_S3_BUCKET_NAME is required when upload is enabled.")
    session = boto3.Session(profile_name=profile, region_name=region) if profile else boto3.Session(region_name=region)
    client = session.client("s3")
    ingest_date = (now or datetime.now(timezone.utc)).date().isoformat()
    root = f"raw/osm/{dataset}/ingest_date={ingest_date}/run_id={run_id}"
    geojson_key = f"{root}/road_segments.geojson"
    attributes_key = f"{root}/road_attributes.csv"
    metadata_key = f"{root}/metadata.json"
    manifest_key = f"manifests/data-ingestion/{run_id}.json"
    checksum = hashlib.sha256(geojson.read_bytes()).hexdigest()
    attributes_checksum = hashlib.sha256(attributes.read_bytes()).hexdigest()
    metadata_checksum = hashlib.sha256(metadata.read_bytes()).hexdigest()
    collection_metadata = json.loads(metadata.read_text(encoding="utf-8"))
    if collection_metadata.get("checksum_sha256") != checksum:
        raise ValueError("road metadata checksum does not match road_segments.geojson")
    try:
        client.upload_file(str(geojson), bucket, geojson_key, ExtraArgs={
            "ContentType": "application/geo+json", "Metadata": {"sha256": checksum, "run-id": run_id, "source": "openstreetmap"},
        })
        client.upload_file(str(attributes), bucket, attributes_key, ExtraArgs={
            "ContentType": "text/csv; charset=utf-8", "Metadata": {"sha256": attributes_checksum, "run-id": run_id, "source": "openstreetmap"},
        })
        client.upload_file(str(metadata), bucket, metadata_key, ExtraArgs={
            "ContentType": "application/json", "Metadata": {"sha256": metadata_checksum, "run-id": run_id, "source": "openstreetmap"},
        })
        manifest: dict[str, Any] = {
            **{key: collection_metadata[key] for key in (
                "metadata_schema_version", "run_id", "dataset", "source", "source_urls",
                "fetched_at", "target_start_at", "target_end_at", "checksum_sha256", "is_simulated",
            )},
            "pipeline": "road-network-ingestion", "status": "collected",
            "started_at": collection_metadata["target_start_at"],
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "output_keys": [f"s3://{bucket}/{geojson_key}", f"s3://{bucket}/{attributes_key}", f"s3://{bucket}/{metadata_key}"],
            "input_count": 1, "output_count": 2,
        }
        client.put_object(Bucket=bucket, Key=manifest_key, Body=(json.dumps(manifest, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"), ContentType="application/json")
    except NoCredentialsError as error:
        raise RuntimeError("AWS credentials were not found. Configure an AWS CLI profile, use an IAM role, or run with --skip-upload.") from error
    except (BotoCoreError, ClientError) as error:
        raise RuntimeError(f"S3 upload failed: {error}") from error
    LOGGER.info("Uploaded immutable road outputs to s3://%s/%s/", bucket, root)
    return {"geojson_key": geojson_key, "attributes_key": attributes_key, "metadata_key": metadata_key, "manifest_key": manifest_key}
