import unittest
from unittest.mock import Mock, patch

from data_processing.plow_gps.pipeline import build_road_index, match_segment, process_events


class GpsPipelineTest(unittest.TestCase):
    def setUp(self):
        self.roads = {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature", "properties": {"segment_id": "s-1"},
                "geometry": {"type": "LineString", "coordinates": [[138.79, 37.44], [138.80, 37.44]]},
            }],
        }
        self.event = {
            "schema_version": "1.0.0", "event_id": "event-1", "run_id": "gps-sim-test",
            "vehicle_id": "snowplow-01", "observed_at": "2026-01-23T12:00:00+09:00",
            "received_at": "2026-07-21T12:00:00+00:00", "latitude": 37.44,
            "longitude": 138.795, "speed_kmh": 18, "heading_degrees": 90,
            "accuracy_m": 5, "operation": "snow_removal", "ground_truth_segment_id": "s-1",
            "source": "yukisaki-gps-simulator", "is_simulated": True,
        }

    def test_matches_point_to_nearest_segment(self):
        segment_id, distance = match_segment(37.44001, 138.795, build_road_index(self.roads))
        self.assertEqual(segment_id, "s-1")
        self.assertLess(distance, 2)

    @patch("data_processing.plow_gps.pipeline.s3_client")
    def test_writes_normalized_curated_and_manifest_before_queueing(self, client_factory):
        client = Mock()
        client_factory.return_value = client
        result = process_events([self.event], bucket="data-bucket", road_index=build_road_index(self.roads))
        self.assertEqual(result["recordCount"], 1)
        self.assertEqual(result["segmentIds"], ["s-1"])
        keys = [call.kwargs["Key"] for call in client.put_object.call_args_list]
        self.assertTrue(any(key.startswith("normalized/simulated/plow-gps/") for key in keys))
        self.assertTrue(any(key.startswith("curated/snowplow-passages/") for key in keys))
        self.assertTrue(any(key.startswith("manifests/data-processing/") for key in keys))


if __name__ == "__main__":
    unittest.main()
