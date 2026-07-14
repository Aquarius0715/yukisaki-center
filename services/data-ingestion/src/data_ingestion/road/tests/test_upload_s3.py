from unittest.mock import Mock, patch

from data_ingestion.road.src.upload_s3 import upload_outputs


def test_uploads_expected_keys_and_content_types(tmp_path):
    geojson, attributes, metadata = tmp_path / "a.geojson", tmp_path / "attributes.csv", tmp_path / "b.json"
    geojson.write_text("{}", encoding="utf-8"); attributes.write_text("segment_id\n1\n", encoding="utf-8"); metadata.write_text("{}", encoding="utf-8")
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
