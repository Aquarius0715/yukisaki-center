"""Command line entry point for generating snow-navigation road segments."""
from __future__ import annotations

import argparse
import hashlib
import json
import uuid
from datetime import datetime, timezone
import logging
from pathlib import Path
from statistics import median

from .config import load_settings
from .export_geojson import write_attributes_csv, write_geojson, write_metadata
from .fetch_osm import fetch_drive_network, graph_edges
from .segment_roads import add_wgs84_endpoints, deduplicate_edges, segment_edges
from .upload_s3 import upload_outputs


def parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""
    result = argparse.ArgumentParser(description="Generate driveable road segments for snow navigation.")
    result.add_argument("--place-name"); result.add_argument("--segment-length", type=float)
    result.add_argument("--fallback-center-lat", type=float); result.add_argument("--fallback-center-lon", type=float)
    result.add_argument("--radius", type=float); result.add_argument("--output", type=Path); result.add_argument("--metadata-output", type=Path); result.add_argument("--attributes-output", type=Path)
    result.add_argument("--aws-profile"); result.add_argument("--s3-bucket")
    result.add_argument("--skip-upload", action="store_true"); result.add_argument("--log-level", default="INFO")
    return result


def run(args: argparse.Namespace, force_upload: bool = False) -> dict[str, object]:
    """Execute acquisition, segmentation, local export, and optional upload."""
    settings = load_settings().with_overrides(
        place_name=args.place_name, segment_length_m=args.segment_length, fallback_center_lat=args.fallback_center_lat,
        fallback_center_lon=args.fallback_center_lon, fallback_radius_m=args.radius, output=args.output,
        metadata_output=args.metadata_output, attributes_output=args.attributes_output, aws_profile=args.aws_profile, s3_bucket=args.s3_bucket,
    )
    started_at = datetime.now(timezone.utc)
    run_id = getattr(args, "run_id", None) or str(uuid.uuid4())
    acquired = fetch_drive_network(settings.place_name, settings.fallback_center_lat, settings.fallback_center_lon, settings.fallback_radius_m)
    edges = graph_edges(acquired.graph)
    deduplicated = deduplicate_edges(edges)
    metric = deduplicated.to_crs(deduplicated.estimate_utm_crs())
    segments_metric, skipped = segment_edges(metric, settings.segment_length_m)
    if segments_metric.empty:
        raise RuntimeError("No usable road segments were generated.")
    segments = add_wgs84_endpoints(segments_metric)
    write_geojson(segments, settings.output)
    write_attributes_csv(segments, settings.attributes_output)
    lengths = list(segments["length_m"])
    metadata: dict[str, object] = {
        "schema_version": "1.0.0", "source": "osm", "created_at": started_at.isoformat(),
        "fetched_at": datetime.now(timezone.utc).isoformat(), "run_id": run_id, "is_simulated": False,
        "source_url": "https://www.openstreetmap.org/", "target_place": settings.place_name,
        "acquisition_method": acquired.method, "osm_network_type": "drive", "target_segment_length_m": settings.segment_length_m,
        "projected_crs": str(metric.crs), "source_edge_count": len(edges), "deduplicated_edge_count": len(deduplicated),
        "segment_count": len(segments), "minimum_segment_length_m": min(lengths), "maximum_segment_length_m": max(lengths),
        "average_segment_length_m": round(sum(lengths) / len(lengths), 2), "median_segment_length_m": median(lengths),
        "output_crs": "EPSG:4326", "output_file": str(settings.output), "attributes_file": str(settings.attributes_output),
    }
    metadata["checksum_sha256"] = hashlib.sha256(settings.output.read_bytes()).hexdigest()
    write_metadata(metadata, settings.metadata_output)
    logging.info("Edges: %d -> %d; skipped geometries: %d; segments: %d", len(edges), len(deduplicated), skipped, len(segments))
    logging.info("Segment lengths min/max/avg/median: %s/%s/%s/%s", metadata["minimum_segment_length_m"], metadata["maximum_segment_length_m"], metadata["average_segment_length_m"], metadata["median_segment_length_m"])
    logging.info("Staged GeoJSON: %s; attributes: %s; metadata: %s", settings.output, settings.attributes_output, settings.metadata_output)
    if (settings.upload_to_s3 or force_upload) and not args.skip_upload:
        upload_outputs(settings.output, settings.attributes_output, settings.metadata_output, settings.s3_bucket or "", settings.s3_dataset, run_id, settings.aws_profile, settings.aws_region, started_at)
        if args.output is None:
            settings.output.unlink(missing_ok=True)
        if args.attributes_output is None:
            settings.attributes_output.unlink(missing_ok=True)
        if args.metadata_output is None:
            settings.metadata_output.unlink(missing_ok=True)
    else:
        logging.info("S3 upload skipped")
    return metadata


def main() -> None:
    """Configure logging and invoke the command."""
    args = parser().parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO), format="%(levelname)s %(message)s")
    try:
        run(args)
    except Exception as error:
        logging.error("Road generation failed: %s", error)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()

