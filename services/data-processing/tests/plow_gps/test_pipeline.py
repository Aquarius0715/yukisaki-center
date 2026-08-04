import hashlib
import json
import unittest
from unittest.mock import Mock, patch

from data_processing.plow_gps import pipeline
from data_processing.plow_gps.pipeline import (
    build_road_index,
    load_message,
    match_segment,
    process_events,
    write_live_positions,
)


class FakeCursor:
    def __init__(self):
        self.executed = []
        self.executemany_calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, statement, params=None):
        self.executed.append((statement, params))

    def executemany(self, statement, rows):
        self.executemany_calls.append((statement, list(rows)))


def _curated_object(records):
    body = ("\n".join(json.dumps(record, sort_keys=True) for record in records) + "\n").encode()
    checksum = hashlib.sha256(body).hexdigest()
    return body, checksum


class FakeConnection:
    def __init__(self):
        self.fake_cursor = FakeCursor()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self.fake_cursor


class GpsPipelineTest(unittest.TestCase):
    def setUp(self):
        # The schema-ensured flag is process-global (persists across warm
        # Lambda invocations by design); reset it so tests stay isolated.
        pipeline._GPS_SCHEMA_ENSURED = False
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

    @patch("data_processing.plow_gps.pipeline.dynamodb_resource")
    def test_live_positions_write_latest_per_vehicle_without_road_matching(self, resource_factory):
        resource = Mock()
        table = Mock()
        resource.Table.return_value = table
        resource_factory.return_value = resource
        batch = Mock()
        table.batch_writer.return_value.__enter__ = Mock(return_value=batch)
        table.batch_writer.return_value.__exit__ = Mock(return_value=False)

        older = {**self.event, "event_id": "event-0", "observed_at": "2026-01-23T11:59:00+09:00"}
        count = write_live_positions([self.event, older], table_name="live-table")

        self.assertEqual(2, count)
        resource.Table.assert_called_once_with("live-table")
        table.batch_writer.assert_called_once_with(overwrite_by_pkeys=["vehicle_id"])
        put_items = [call.kwargs["Item"] for call in batch.put_item.call_args_list]
        # Sorted oldest-first so batch_writer's per-key overwrite keeps the latest observation.
        self.assertEqual([older["observed_at"], self.event["observed_at"]], [item["observed_at"] for item in put_items])
        self.assertNotIn("matched_segment_id", put_items[0])
        self.assertNotIn("ground_truth_segment_id", put_items[0])

    @patch("data_processing.plow_gps.pipeline.connect_database")
    @patch("data_processing.plow_gps.pipeline.s3_client")
    def test_load_message_batches_writes_and_dedupes_vehicle_upserts(self, client_factory, connect):
        curated_event = {**self.event, "matched_segment_id": "s-1", "match_distance_m": 1.2}
        second_tick = {**curated_event, "event_id": "event-2", "observed_at": "2026-01-23T12:00:05+09:00"}
        other_vehicle = {**curated_event, "event_id": "event-3", "vehicle_id": "snowplow-02"}
        records = [curated_event, second_tick, other_vehicle]
        body, checksum = _curated_object(records)
        s3 = Mock()
        s3.get_object.return_value = {
            "Body": Mock(read=Mock(return_value=body)),
            "Metadata": {"sha256": checksum},
        }
        client_factory.return_value = s3
        connection = FakeConnection()
        connect.return_value = connection

        result = load_message({
            "bucket": "data-bucket", "curatedKey": "curated/snowplow-passages/x.jsonl",
            "checksumSha256": checksum, "recordCount": 3, "processingRunId": "gps-process-test",
        })

        self.assertEqual(3, result["recordCount"])
        self.assertEqual("gps-process-test", result["runId"])
        # One executemany per table, in this order: vehicles, positions, passages.
        vehicle_rows = connection.fake_cursor.executemany_calls[0][1]
        position_rows = connection.fake_cursor.executemany_calls[1][1]
        passage_rows = connection.fake_cursor.executemany_calls[2][1]
        self.assertEqual(
            {("snowplow-01", "snowplow-01", "yukisaki-gps-simulator"), ("snowplow-02", "snowplow-02", "yukisaki-gps-simulator")},
            set(vehicle_rows),
        )
        self.assertEqual(3, len(position_rows))
        self.assertEqual(3, len(passage_rows))

    @patch("data_processing.plow_gps.pipeline.connect_database")
    @patch("data_processing.plow_gps.pipeline.s3_client")
    def test_schema_ddl_runs_once_across_warm_invocations(self, client_factory, connect):
        curated_event = {**self.event, "matched_segment_id": "s-1", "match_distance_m": 1.2}
        body, checksum = _curated_object([curated_event])
        s3 = Mock()
        s3.get_object.return_value = {
            "Body": Mock(read=Mock(return_value=body)),
            "Metadata": {"sha256": checksum},
        }
        client_factory.return_value = s3
        first_connection = FakeConnection()
        second_connection = FakeConnection()
        connect.side_effect = [first_connection, second_connection]

        for _ in range(2):
            load_message({
                "bucket": "data-bucket", "curatedKey": "curated/snowplow-passages/x.jsonl",
                "checksumSha256": checksum, "recordCount": 1, "processingRunId": "gps-process-test",
            })

        def schema_calls(connection):
            return sum(1 for statement, _ in connection.fake_cursor.executed if "CREATE TABLE" in statement)

        self.assertEqual(1, schema_calls(first_connection))
        self.assertEqual(0, schema_calls(second_connection))


if __name__ == "__main__":
    unittest.main()
