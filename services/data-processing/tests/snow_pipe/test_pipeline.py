import hashlib
import io
import json
import unittest
from unittest.mock import Mock

from data_processing.snow_pipe import pipeline
from data_processing.snow_pipe.pipeline import (
    database_rows,
    deterministic_processing_run_id,
    merge_feature_collection,
    merge_objects,
    parse_jsonl,
)


class SnowPipePipelineTest(unittest.TestCase):
    def setUp(self):
        self.roads = {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[138.7, 37.4], [138.8, 37.5]]},
                "properties": {
                    "segment_id": "segment-1", "road_name": "国道8号", "highway": "primary",
                    "length_m": 25.0, "source_edge_id": "edge-1",
                },
            }],
        }
        self.snow = [{
            "segment_id": "segment-1", "snow_pipe": True, "operation_status": "unknown",
            "effectiveness": 0.8, "updated_at": "2026-01-23T12:00:00+09:00",
            "source": "simulated-road-name-rule", "rule_version": "road-name-v1",
            "source_road_run_id": "road-1", "is_simulated": True,
        }]

    def test_merges_by_segment_id_and_builds_database_rows(self):
        merged = merge_feature_collection(self.roads, self.snow, expected_road_run_id="road-1")
        properties = merged["features"][0]["properties"]
        self.assertTrue(properties["snow_pipe"])
        self.assertTrue(properties["snow_pipe_is_simulated"])
        rows = database_rows(merged, "processing-1")
        self.assertEqual("segment-1", rows[0][0][0])
        self.assertEqual("processing-1", rows[0][1][7])

    def test_rejects_unknown_segment(self):
        self.snow[0]["segment_id"] = "unknown"
        with self.assertRaisesRegex(ValueError, "missing"):
            merge_feature_collection(self.roads, self.snow, expected_road_run_id="road-1")

    def test_requires_simulated_flag(self):
        self.snow[0]["is_simulated"] = False
        with self.assertRaisesRegex(ValueError, "is_simulated"):
            merge_feature_collection(self.roads, self.snow, expected_road_run_id="road-1")

    def test_parses_json_lines_and_run_id_is_deterministic(self):
        self.assertEqual(self.snow, parse_jsonl((__import__("json").dumps(self.snow[0]) + "\n").encode()))
        value = deterministic_processing_run_id("road-1", "snow-1")
        self.assertEqual(value, deterministic_processing_run_id("road-1", "snow-1"))

    def test_reads_cross_bucket_inputs_and_writes_curated_to_snow_bucket(self):
        road_body = json.dumps(self.roads).encode()
        snow_body = (json.dumps(self.snow[0]) + "\n").encode()
        road_checksum = hashlib.sha256(road_body).hexdigest()
        snow_checksum = hashlib.sha256(snow_body).hexdigest()
        client = Mock()

        def get_object(*, Bucket, Key):
            bodies = {("road-bucket", "road.geojson"): (road_body, road_checksum),
                      ("snow-bucket", "snow.jsonl"): (snow_body, snow_checksum)}
            body, checksum = bodies[(Bucket, Key)]
            return {"Body": io.BytesIO(body), "Metadata": {"sha256": checksum}}

        client.get_object.side_effect = get_object
        previous = pipeline._S3_CLIENT
        pipeline._S3_CLIENT = client
        try:
            result = merge_objects({
                "roadBucket": "road-bucket", "roadKey": "road.geojson",
                "roadChecksumSha256": road_checksum, "roadRunId": "road-1",
                "snowPipeBucket": "snow-bucket", "snowPipeKey": "snow.jsonl",
                "snowPipeChecksumSha256": snow_checksum, "snowPipeRunId": "snow-1",
                "referenceTime": "2026-01-23T12:00:00+09:00",
            })
        finally:
            pipeline._S3_CLIENT = previous

        self.assertEqual("snow-bucket", result["bucket"])
        self.assertTrue(all(call.kwargs["Bucket"] == "snow-bucket" for call in client.put_object.call_args_list))


if __name__ == "__main__":
    unittest.main()
