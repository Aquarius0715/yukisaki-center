"""Canonical collection metadata shared by weather, road, and future collectors."""

from __future__ import annotations

import hashlib
from typing import Any

COLLECTION_METADATA_SCHEMA_VERSION = "1.0.0"


def sha256_bytes(value: bytes) -> str:
    """Return the lowercase SHA-256 digest used by all collection contracts."""
    return hashlib.sha256(value).hexdigest()


def build_collection_metadata(
    *,
    run_id: str,
    dataset: str,
    source: str,
    source_urls: list[str],
    fetched_at: str,
    target_start_at: str,
    target_end_at: str,
    checksum_sha256: str,
    is_simulated: bool,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the required metadata envelope for an immutable S3 raw object."""
    required_strings = {
        "run_id": run_id,
        "dataset": dataset,
        "source": source,
        "fetched_at": fetched_at,
        "target_start_at": target_start_at,
        "target_end_at": target_end_at,
        "checksum_sha256": checksum_sha256,
    }
    missing = [name for name, value in required_strings.items() if not value]
    if missing:
        raise ValueError(f"collection metadata fields must not be empty: {', '.join(missing)}")
    if not source_urls:
        raise ValueError("source_urls must contain at least one URL")

    metadata: dict[str, Any] = {
        "metadata_schema_version": COLLECTION_METADATA_SCHEMA_VERSION,
        **required_strings,
        "source_urls": source_urls,
        "is_simulated": is_simulated,
    }
    if extra:
        metadata.update(extra)
    return metadata
