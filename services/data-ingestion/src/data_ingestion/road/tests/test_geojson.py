import json

import geopandas as gpd
from shapely.geometry import LineString

from src.export_geojson import write_geojson
from src.segment_roads import add_wgs84_endpoints, segment_edges


def test_geojson_is_wgs84_and_keeps_japanese(tmp_path):
    edge = gpd.GeoDataFrame([{"u": 1, "v": 2, "key": 0, "osmid": 1, "name": "石動南町道路", "highway": "residential", "oneway": False, "geometry": LineString([(0, 0), (50, 0)])}], crs="EPSG:32654")
    segments, _ = segment_edges(edge, 25)
    output = tmp_path / "roads.geojson"
    write_geojson(add_wgs84_endpoints(segments), output)
    data = json.loads(output.read_text(encoding="utf-8"))
    feature = data["features"][0]
    assert data["type"] == "FeatureCollection"
    assert feature["geometry"]["type"] == "LineString"
    assert feature["properties"]["name"] == "石動南町道路"
    assert feature["properties"]["road_name"] == "石動南町道路"
    assert feature["properties"]["snow_depth_cm"] is None
    assert feature["properties"]["snow_level"] == "unknown"

