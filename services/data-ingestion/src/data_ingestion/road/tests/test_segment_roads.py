import math

import geopandas as gpd
import pytest
from shapely.geometry import LineString, MultiLineString

from src.segment_roads import segment_count_for_length, segment_edges


def edge(geometry):
    return gpd.GeoDataFrame([{"u": 1, "v": 2, "key": 0, "osmid": 99, "name": "テスト道路", "highway": "residential", "oneway": False, "geometry": geometry}], crs="EPSG:32654")


@pytest.mark.parametrize("length,count,expected", [(10, 1, 10), (20, 1, 20), (25, 1, 25), (40, 2, 20), (50, 2, 25), (60, 3, 20), (70, 3, 70 / 3), (100, 4, 25), (110, 4, 27.5)])
def test_uniform_lengths(length, count, expected):
    segments, skipped = segment_edges(edge(LineString([(0, 0), (length, 0)])), 25)
    assert skipped == 0 and len(segments) == count
    assert all(item.length == pytest.approx(expected) for item in segments.geometry)
    assert sum(item.length for item in segments.geometry) == pytest.approx(length)
    assert all(item.geom_type == "LineString" for item in segments.geometry)


def test_curved_and_multiline_are_split_along_geometry():
    curved = LineString([(0, 0), (30, 0), (30, 40)])
    segments, _ = segment_edges(edge(curved), 25)
    assert len(segments) == 3
    assert all(part.length == pytest.approx(70 / 3) for part in segments.geometry)
    multi = MultiLineString([[(0, 0), (25, 0)], [(25, 0), (50, 0)]])
    segments, _ = segment_edges(edge(multi), 25)
    assert len(segments) == 2


def test_ids_are_stable_and_empty_geometry_is_skipped():
    first, _ = segment_edges(edge(LineString([(0, 0), (50, 0)])), 25)
    second, _ = segment_edges(edge(LineString([(0, 0), (50, 0)])), 25)
    assert list(first.segment_id) == list(second.segment_id)
    assert len(set(first.segment_id)) == len(first)
    empty, skipped = segment_edges(edge(LineString()), 25)
    assert empty.empty and skipped == 1

