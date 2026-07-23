"""Configuration loading for the road generator."""
from __future__ import annotations

from dataclasses import dataclass, replace
import os
from pathlib import Path
import tempfile
from typing import Any

from dotenv import load_dotenv


def _optional_float(value: str | None) -> float | None:
    return float(value) if value not in (None, "") else None


def _bool(value: str | None) -> bool:
    return (value or "false").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    """Runtime settings, loaded from environment and overridable by CLI."""

    place_name: str = "新潟県長岡市"
    segment_length_m: float = 25.0
    fallback_center_lat: float | None = None
    fallback_center_lon: float | None = None
    fallback_radius_m: float = 35_000.0
    aws_profile: str | None = None
    aws_region: str = "ap-northeast-1"
    s3_bucket: str | None = None
    s3_dataset: str = "road-network"
    upload_to_s3: bool = False
    # S3 is the durable destination. Temporary files are only upload staging.
    output: Path = Path(tempfile.gettempdir()) / "nagaoka_city_road_segments.geojson"
    metadata_output: Path = Path(tempfile.gettempdir()) / "nagaoka_city_metadata.json"
    attributes_output: Path = Path(tempfile.gettempdir()) / "nagaoka_city_road_attributes.csv"

    def with_overrides(self, **values: Any) -> "Settings":
        """Return settings with non-None command line values applied."""
        return replace(self, **{key: value for key, value in values.items() if value is not None})


def load_settings(env_file: Path | None = None) -> Settings:
    """Load settings from .env and the process environment."""
    load_dotenv(env_file or Path(".env"))
    return Settings(
        place_name=os.getenv("OSM_PLACE_NAME", Settings.place_name),
        segment_length_m=float(os.getenv("ROAD_SEGMENT_TARGET_LENGTH_M", "25")),
        fallback_center_lat=_optional_float(os.getenv("FALLBACK_CENTER_LAT")),
        fallback_center_lon=_optional_float(os.getenv("FALLBACK_CENTER_LON")),
        fallback_radius_m=float(os.getenv("FALLBACK_RADIUS_M", "35000")),
        aws_profile=os.getenv("AWS_PROFILE") or None,
        aws_region=os.getenv("AWS_REGION", "ap-northeast-1"),
        # DATA_BUCKET is the service-wide contract; ROAD_S3_BUCKET_NAME keeps
        # local/demo deployments isolated when a dedicated bucket is used.
        s3_bucket=os.getenv("ROAD_S3_BUCKET_NAME") or os.getenv("DATA_BUCKET") or None,
        s3_dataset=os.getenv("ROAD_S3_DATASET", "road-network"),
        upload_to_s3=_bool(os.getenv("UPLOAD_TO_S3")),
    )
