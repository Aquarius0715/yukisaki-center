import unittest

from data_ingestion.common.metadata import build_collection_metadata, sha256_bytes


class CollectionMetadataTest(unittest.TestCase):
    def test_builds_the_canonical_collection_envelope(self):
        checksum = sha256_bytes(b"raw-data")
        metadata = build_collection_metadata(
            run_id="run-1",
            dataset="example",
            source="example-source",
            source_urls=["https://example.test/source"],
            fetched_at="2026-07-14T00:00:00+00:00",
            target_start_at="2026-01-23T09:00:00+09:00",
            target_end_at="2026-01-23T15:00:00+09:00",
            checksum_sha256=checksum,
            is_simulated=False,
        )

        self.assertEqual(metadata["metadata_schema_version"], "1.0.0")
        self.assertEqual(metadata["run_id"], "run-1")
        self.assertEqual(metadata["checksum_sha256"], checksum)
        self.assertFalse(metadata["is_simulated"])

    def test_rejects_an_incomplete_envelope(self):
        with self.assertRaises(ValueError):
            build_collection_metadata(
                run_id="",
                dataset="example",
                source="example-source",
                source_urls=[],
                fetched_at="2026-07-14T00:00:00+00:00",
                target_start_at="2026-01-23T09:00:00+09:00",
                target_end_at="2026-01-23T15:00:00+09:00",
                checksum_sha256="checksum",
                is_simulated=False,
            )


if __name__ == "__main__":
    unittest.main()
