"""GeoJSON and run metadata output."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import geopandas as gpd


def write_geojson(segments: gpd.GeoDataFrame, output: Path) -> None:
    """Write UTF-8 WGS84 GeoJSON, creating its parent folder."""
    output.parent.mkdir(parents=True, exist_ok=True)
    segments.to_file(output, driver="GeoJSON", encoding="utf-8")


def write_metadata(metadata: dict[str, Any], output: Path) -> None:
    """Write readable UTF-8 JSON metadata."""
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")


def write_attributes_csv(segments: gpd.GeoDataFrame, output: Path) -> None:
    """Write non-geometric road attributes as a UTF-8 CSV analysis table."""
    output.parent.mkdir(parents=True, exist_ok=True)
    segments.drop(columns="geometry").to_csv(output, index=False, encoding="utf-8")

