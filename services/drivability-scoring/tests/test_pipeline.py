import unittest
from datetime import datetime
from unittest.mock import Mock, patch

from drivability_scoring.pipeline import score_message


class FakeCursor:
    def __init__(self):
        self.statement = ""

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, statement, _params=None):
        self.statement = statement

    def fetchone(self):
        return (1,)

    def fetchall(self):
        return [(
            "s-1", 3, -1, 1, 0.2, True, "active",
            datetime.fromisoformat("2026-01-23T11:59:00+09:00"),
        )]


class FakeConnection:
    def __init__(self):
        self.fake_cursor = FakeCursor()

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
    def test_saves_score_truth_and_returns_a_traceable_run(self, connect, s3_factory):
        connect.return_value = FakeConnection()
        s3 = Mock()
        s3_factory.return_value = s3
        result = score_message({
            "processingRunId": "gps-process-test",
            "segmentIds": ["s-1"],
            "latestObservedAt": "2026-01-23T12:00:00+09:00",
        })
        self.assertEqual(result["runId"], "score-gps-process-test")
        self.assertEqual(result["recordCount"], 1)
        self.assertTrue(s3.put_object.call_args.kwargs["Key"].startswith("curated/drivability-scores/"))


if __name__ == "__main__":
    unittest.main()
