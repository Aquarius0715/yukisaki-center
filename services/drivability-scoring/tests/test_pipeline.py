import unittest
from datetime import datetime
from unittest.mock import Mock, patch

from drivability_scoring.pipeline import handler, score_message


class FakeCursor:
    def __init__(self, all_segment_ids=None):
        self.statement = ""
        self.all_segment_ids = all_segment_ids or ["s-1"]
        self.requested_segment_ids = []
        self.projected_rows = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, statement, params=None):
        self.statement = statement
        if "FROM road_segments r" in statement:
            self.requested_segment_ids = list(params[1])

    def executemany(self, _statement, rows):
        self.projected_rows.extend(rows)

    def fetchone(self):
        return (1,)

    def fetchall(self):
        if "SELECT segment_id FROM road_segments" in self.statement:
            return [("s-1",), ("s-2",)]
        return [(
            "s-1", 3, -1, 1, 0.2, True, "active",
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
