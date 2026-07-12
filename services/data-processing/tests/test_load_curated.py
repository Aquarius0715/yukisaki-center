import unittest

from data_processing.load_curated import parse_s3_uri


class LoadCuratedTest(unittest.TestCase):
    def test_parses_s3_uri(self):
        self.assertEqual(
            parse_s3_uri("s3://example/normalized/weather/part.jsonl"),
            ("example", "normalized/weather/part.jsonl"),
        )

    def test_rejects_non_s3_uri(self):
        with self.assertRaises(ValueError):
            parse_s3_uri("https://example/part.jsonl")


if __name__ == "__main__":
    unittest.main()
