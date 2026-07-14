"""Shared contracts for every data-ingestion source."""

from .metadata import COLLECTION_METADATA_SCHEMA_VERSION, build_collection_metadata, sha256_bytes

__all__ = ["COLLECTION_METADATA_SCHEMA_VERSION", "build_collection_metadata", "sha256_bytes"]
