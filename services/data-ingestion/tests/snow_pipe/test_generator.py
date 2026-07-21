import hashlib
import io
import json
import unittest
from unittest.mock import Mock

from data_ingestion.snow_pipe import generator
from data_ingestion.snow_pipe.generator import (
    _manifest_location,
    deterministic_run_id,
    generate_records,
    process_manifest,
)


class SnowPipeGeneratorTest(unittest.TestCase):
    def test_generates_simulated_records_from_road_names(self):
        roads = {
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "properties": {"segment_id": "named", "road_name": "国道8号"}},
                {"type": "Feature", "properties": {"segment_id": "blank", "road_name": "  "}},
                {"type": "Feature", "properties": {"segment_id": "missing"}},
                {"type": "Feature", "properties": {"segment_id": "legacy", "road_name": None, "name": "県道23号"}},
            ],
        }
        records = generate_records(
            roads, road_run_id="road-1", reference_time="2026-01-23T12:00:00+09:00"
        )
        self.assertEqual([True, False, False, True], [record["snow_pipe"] for record in records])
        self.assertTrue(all(record["is_simulated"] for record in records))
        self.assertEqual("unknown", records[0]["operation_status"])
        self.assertEqual(0.8, records[0]["effectiveness"])

    def test_rejects_duplicate_segment_ids(self):
        roads = {
            "type": "FeatureCollection",
            "features": [
                {"properties": {"segment_id": "same", "road_name": "A"}},
                {"properties": {"segment_id": "same", "road_name": "B"}},
            ],
        }
        with self.assertRaisesRegex(ValueError, "duplicate"):
            generate_records(roads, road_run_id="road-1", reference_time="2026-01-23T12:00:00+09:00")

    def test_run_id_is_deterministic_and_versioned(self):
        first = deterministic_run_id("road-1", "v1", "2026-01-23T12:00:00+09:00")
        self.assertEqual(first, deterministic_run_id("road-1", "v1", "2026-01-23T12:00:00+09:00"))
        self.assertNotEqual(first, deterministic_run_id("road-1", "v2", "2026-01-23T12:00:00+09:00"))

    def test_extracts_manifest_from_cloudtrail_event(self):
        event = {
            "detail": {
                "requestParameters": {
                    "bucketName": "road-bucket",
                    "key": "manifests/data-ingestion/run-1.json",
                }
            }
        }
        self.assertEqual(
            ("road-bucket", "manifests/data-ingestion/run-1.json"),
            _manifest_location(event),
        )

    def test_reads_roads_from_road_bucket_and_writes_to_snow_bucket(self):
        roads = {
            "type": "FeatureCollection",
            "features": [{"type": "Feature", "properties": {"segment_id": "s-1", "name": "国道8号"}}],
        }
        road_body = json.dumps(roads).encode()
        road_checksum = hashlib.sha256(road_body).hexdigest()
        manifest = {
            "dataset": "road-network",
            "status": "collected",
            "run_id": "road-1",
            "checksum_sha256": road_checksum,
            "output_keys": ["s3://road-bucket/raw/osm/road-network/road_segments.geojson"],
        }
        client = Mock()
        client.get_object.side_effect = [
            {"Body": io.BytesIO(json.dumps(manifest).encode()), "Metadata": {}},
            {"Body": io.BytesIO(road_body), "Metadata": {"sha256": road_checksum}},
        ]
        previous = generator._S3_CLIENT
        generator._S3_CLIENT = client
        try:
            result = process_manifest(
                "road-bucket", "manifests/data-ingestion/road-1.json",
                output_bucket="snow-bucket",
            )
        finally:
            generator._S3_CLIENT = previous

        self.assertEqual("road-bucket", result["roadBucket"])
        self.assertEqual("snow-bucket", result["snowPipeBucket"])
        self.assertTrue(client.put_object.call_args_list)
        self.assertTrue(all(call.kwargs["Bucket"] == "snow-bucket" for call in client.put_object.call_args_list))


if __name__ == "__main__":
    unittest.main()
