import unittest
from datetime import datetime
from unittest.mock import Mock, patch

from drivability_scoring import pipeline
from drivability_scoring.pipeline import handler, score_message


class FakeCursor:
    def __init__(self, all_segment_ids=None):
        self.statement = ""
        self.all_segment_ids = all_segment_ids or ["s-1"]
        self.requested_segment_ids = []
        self.projected_rows = []
        # Matches the segment row's (37.44, 138.79) below, so the nearest-point
        # match is exact and the resulting score inputs stay -1 / 1 / 0.2 as
        # before the weather lookup moved out of the per-segment SQL query.
        self.weather_points = [(37.44, 138.79, -1, 1, 0.2)]
        self.weather_query_count = 0
        self.schema_query_count = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, statement, params=None):
        self.statement = statement
        if "FROM weather_hourly_windows" in statement:
            self.weather_query_count += 1
        if "CREATE TABLE" in statement:
            self.schema_query_count += 1
        if "FROM road_segments r" in statement:
            self.requested_segment_ids = list(params[1])

    def executemany(self, _statement, rows):
        self.projected_rows.extend(rows)

    def fetchone(self):
        return (1,)

    def fetchall(self):
        if "SELECT segment_id FROM road_segments" in self.statement:
            return [("s-1",), ("s-2",)]
        if "FROM weather_hourly_windows" in self.statement:
            return self.weather_points
        return [(
            "s-1", 3, "residential", 37.44, 138.79, True, "active",
            datetime.fromisoformat("2026-01-23T11:59:00+09:00"),
        )]


class FakeConnection:
    def __init__(self, segment_ids=None):
        self.fake_cursor = FakeCursor(segment_ids)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self.fake_cursor


class PipelineTest(unittest.TestCase):
    def setUp(self):
        # These caches are process-global (persist across warm Lambda
        # invocations by design); reset them so tests stay isolated.
        pipeline._WEATHER_POINTS = None
        pipeline._SCORE_SCHEMA_ENSURED = False

    @patch.dict("os.environ", {"DATA_BUCKET": "data-bucket"})
    @patch("drivability_scoring.pipeline.s3_client")
    @patch("drivability_scoring.pipeline.connect_database")
    def test_saves_incremental_score_truth_and_returns_a_traceable_run(self, connect, s3_factory):
        connection = FakeConnection()
        connect.return_value = connection
        s3 = Mock()
        s3_factory.return_value = s3
        result = score_message({
            "processingRunId": "gps-process-test",
            "segmentIds": ["s-1"],
            "latestObservedAt": "2026-01-23T12:00:00+09:00",
        })
        self.assertEqual(result["runId"], "score-gps-process-test")
        self.assertEqual(result["recordCount"], 1)
        self.assertEqual(len(connection.fake_cursor.projected_rows), 1)
        self.assertTrue(s3.put_object.call_args.kwargs["Key"].startswith("curated/drivability-scores/"))

    @patch.dict("os.environ", {"DATA_BUCKET": "data-bucket"})
    @patch("drivability_scoring.pipeline.s3_client")
    @patch("drivability_scoring.pipeline.connect_database")
    def test_weather_points_are_fetched_once_and_reused_across_warm_invocations(self, connect, s3_factory):
        first_connection = FakeConnection()
        second_connection = FakeConnection()
        connect.side_effect = [first_connection, second_connection]
        s3_factory.return_value = Mock()
        for _ in range(2):
            score_message({
                "processingRunId": "gps-process-test",
                "segmentIds": ["s-1"],
                "latestObservedAt": "2026-01-23T12:00:00+09:00",
            })
        self.assertEqual(1, first_connection.fake_cursor.weather_query_count)
        self.assertEqual(0, second_connection.fake_cursor.weather_query_count)

    @patch.dict("os.environ", {"DATA_BUCKET": "data-bucket"})
    @patch("drivability_scoring.pipeline.s3_client")
    @patch("drivability_scoring.pipeline.connect_database")
    def test_score_schema_ddl_runs_once_across_warm_invocations(self, connect, s3_factory):
        first_connection = FakeConnection()
        second_connection = FakeConnection()
        connect.side_effect = [first_connection, second_connection]
        s3_factory.return_value = Mock()
        for _ in range(2):
            score_message({
                "processingRunId": "gps-process-test",
                "segmentIds": ["s-1"],
                "latestObservedAt": "2026-01-23T12:00:00+09:00",
            })
        self.assertEqual(1, first_connection.fake_cursor.schema_query_count)
        self.assertEqual(0, second_connection.fake_cursor.schema_query_count)

    @patch("drivability_scoring.pipeline.score_message")
    @patch("drivability_scoring.pipeline.connect_database")
    def test_bootstraps_every_road_segment(self, connect, score):
        connect.return_value = FakeConnection()
        score.return_value = {"runId": "score-bootstrap", "recordCount": 2, "key": "scores.jsonl"}
        result = handler({
            "mode": "bootstrap-all-road-segments",
            "dataTimestamp": "2026-01-23T12:00:00+09:00",
        }, None)
        message = score.call_args.args[0]
        self.assertEqual(message["segmentIds"], ["s-1", "s-2"])
        self.assertEqual(message["latestObservedAt"], "2026-01-23T12:00:00+09:00")
        self.assertEqual(result["scored"][0]["recordCount"], 2)


if __name__ == "__main__":
    unittest.main()
