import base64
import json
import unittest
from unittest.mock import Mock, patch

from data_ingestion.plow_gps.archiver import archive_events, decode_kinesis_records


def gps_event(vehicle_id="snowplow-01"):
    return {
        "schema_version": "1.0.0", "event_id": f"event-{vehicle_id}", "run_id": "gps-sim-test",
        "vehicle_id": vehicle_id, "observed_at": "2026-01-23T12:00:00+09:00",
        "received_at": "2026-07-21T12:00:00+00:00", "latitude": 37.44, "longitude": 138.79,
        "speed_kmh": 18, "heading_degrees": 90, "accuracy_m": 5, "operation": "snow_removal",
        "ground_truth_segment_id": "s-1", "source": "yukisaki-gps-simulator", "is_simulated": True,
    }


class ArchiverTest(unittest.TestCase):
    def test_decodes_and_validates_kinesis_record(self):
        data = base64.b64encode(json.dumps(gps_event()).encode()).decode()
        events = decode_kinesis_records([{"kinesis": {"data": data}}])
        self.assertEqual(events[0]["vehicle_id"], "snowplow-01")

    @patch("data_ingestion.plow_gps.archiver.s3_client")
    def test_archives_raw_and_manifest(self, client_factory):
        client = Mock()
        client_factory.return_value = client
        result = archive_events([gps_event()], bucket="gps-bucket", stream_name="gps-stream")
        self.assertEqual(result["recordCount"], 1)
        self.assertEqual(client.put_object.call_count, 2)
        self.assertTrue(client.put_object.call_args_list[0].kwargs["Key"].startswith("raw/simulated/plow-gps/"))

    def test_rejects_non_simulated_event(self):
        event = gps_event()
        event["is_simulated"] = False
        data = base64.b64encode(json.dumps(event).encode()).decode()
        with self.assertRaisesRegex(ValueError, "is_simulated"):
            decode_kinesis_records([{"kinesis": {"data": data}}])


if __name__ == "__main__":
    unittest.main()
