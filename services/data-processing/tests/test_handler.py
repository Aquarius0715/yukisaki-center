import unittest

from data_processing.handler import normalize_atom_feed, run_id_from_key


SAMPLE_FEED = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>JMA feed</title>
  <entry>
    <id>urn:jma:test:1</id>
    <title>Test bulletin</title>
    <updated>2026-07-12T00:00:00+09:00</updated>
    <link href="https://www.data.jma.go.jp/developer/xml/data/test.xml" />
    <content>summary</content>
  </entry>
</feed>
"""


class NormalizerTest(unittest.TestCase):
    def test_normalizes_atom_entries(self):
        records = normalize_atom_feed(
            SAMPLE_FEED,
            fetched_at="2026-07-11T15:01:00+00:00",
            run_id="run-1",
            schema_version="1.0.0",
        )
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["title"], "Test bulletin")
        self.assertEqual(records[0]["run_id"], "run-1")
        self.assertFalse(records[0]["is_simulated"])

    def test_rejects_non_atom_xml(self):
        with self.assertRaises(ValueError):
            normalize_atom_feed(
                b"<Report />",
                fetched_at="2026-07-11T15:01:00+00:00",
                run_id="run-1",
                schema_version="1.0.0",
            )

    def test_extracts_run_id(self):
        key = "raw/jma/weather-feed/ingest_date=2026-07-12/run_id=abc/response.xml"
        self.assertEqual(run_id_from_key(key), "abc")


if __name__ == "__main__":
    unittest.main()
