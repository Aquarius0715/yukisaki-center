import io
import unittest

from data_ingestion.handler import make_run_id, read_limited_response, validate_source_url


class CollectorHelpersTest(unittest.TestCase):
    def test_accepts_allow_listed_https_url(self):
        validate_source_url(
            "https://www.data.jma.go.jp/developer/xml/feed/regular.xml",
            {"www.data.jma.go.jp"},
        )

    def test_rejects_http_and_unknown_hosts(self):
        with self.assertRaises(ValueError):
            validate_source_url("http://www.data.jma.go.jp/feed.xml", {"www.data.jma.go.jp"})
        with self.assertRaises(ValueError):
            validate_source_url("https://example.com/feed.xml", {"www.data.jma.go.jp"})

    def test_limits_response_size(self):
        self.assertEqual(read_limited_response(io.BytesIO(b"abc"), 3), b"abc")
        with self.assertRaises(ValueError):
            read_limited_response(io.BytesIO(b"abcd"), 3)

    def test_uses_scheduler_execution_id_as_run_id(self):
        self.assertEqual(make_run_id({"executionId": "abc/123"}), "abc_123")


if __name__ == "__main__":
    unittest.main()
