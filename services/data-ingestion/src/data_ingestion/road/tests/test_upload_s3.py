import hashlib
import json
from unittest.mock import Mock, patch

from data_ingestion.road.src.upload_s3 import upload_outputs


def test_uploads_expected_keys_and_content_types(tmp_path):
    geojson, attributes, metadata = tmp_path / "a.geojson", tmp_path / "attributes.csv", tmp_path / "b.json"
    geojson.write_text("{}", encoding="utf-8")
    attributes.write_text("segment_id\n1\n", encoding="utf-8")
    metadata.write_text(json.dumps({
        "metadata_schema_version": "1.0.0",
        "run_id": "run-1",
        "dataset": "road-network",
        "source": "openstreetmap",
        "source_urls": ["https://www.openstreetmap.org/"],
        "fetched_at": "2026-07-14T00:01:00+00:00",
        "target_start_at": "2026-07-14T00:00:00+00:00",
        "target_end_at": "2026-07-14T00:01:00+00:00",
        "checksum_sha256": hashlib.sha256(b"{}").hexdigest(),
        "is_simulated": False,
    }), encoding="utf-8")
    client = Mock()
    with patch("data_ingestion.road.src.upload_s3.boto3.Session") as session:
        session.return_value.client.return_value = client
        upload_outputs(geojson, attributes, metadata, "road-bucket", "road-network", "run-1", None, "ap-northeast-1")
    assert client.upload_file.call_args_list[0].args[1].startswith("road-bucket")
    assert client.upload_file.call_args_list[0].args[2].endswith("run_id=run-1/road_segments.geojson")
    assert client.upload_file.call_args_list[0].kwargs["ExtraArgs"]["ContentType"] == "application/geo+json"
    assert client.upload_file.call_args_list[1].args[2].endswith("road_attributes.csv")
    assert client.upload_file.call_args_list[1].kwargs["ExtraArgs"]["ContentType"] == "text/csv; charset=utf-8"
    assert client.upload_file.call_args_list[2].kwargs["ExtraArgs"]["ContentType"] == "application/json"
    assert client.put_object.call_args.kwargs["Key"] == "manifests/data-ingestion/run-1.json"
    manifest = json.loads(client.put_object.call_args.kwargs["Body"])
    assert manifest["source"] == "openstreetmap"
    assert manifest["target_start_at"] == "2026-07-14T00:00:00+00:00"
    assert manifest["checksum_sha256"] == hashlib.sha256(b"{}").hexdigest()
