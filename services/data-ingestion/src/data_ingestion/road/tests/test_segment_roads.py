import math

import geopandas as gpd
import pytest
from shapely.geometry import LineString, MultiLineString

from data_ingestion.road.src.segment_roads import (
    deduplicate_edges,
    segment_count_for_length,
    segment_edges,
)


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


def test_segments_keep_stable_routing_nodes_and_direction():
    segments, _ = segment_edges(edge(LineString([(0, 0), (50, 0)])), 25)
    assert list(segments.source_node_key) == ["osm:1", f"split:{segments.source_edge_id.iloc[0]}:1"]
    assert list(segments.target_node_key) == [f"split:{segments.source_edge_id.iloc[0]}:1", "osm:2"]
    assert list(segments.routing_oneway) == [False, False]

    reversed_edge = edge(LineString([(0, 0), (50, 0)]))
    reversed_edge["oneway"] = "-1"
    reversed_segments, _ = segment_edges(reversed_edge, 25)
    assert reversed_segments.source_node_key.iloc[0] == "osm:2"
    assert reversed_segments.target_node_key.iloc[-1] == "osm:1"
    assert all(reversed_segments.routing_oneway)
    assert reversed_segments.geometry.iloc[0].coords[0] == (50.0, 0.0)


def test_reverse_oneway_edges_are_not_deduplicated():
    edges = gpd.GeoDataFrame([
        {
            "u": 1, "v": 2, "key": 0, "osmid": 99, "name": "テスト道路",
            "highway": "residential", "oneway": "-1",
            "geometry": LineString([(0, 0), (50, 0)]),
        },
        {
            "u": 2, "v": 1, "key": 0, "osmid": 99, "name": "テスト道路",
            "highway": "residential", "oneway": "-1",
            "geometry": LineString([(50, 0), (0, 0)]),
        },
    ], crs="EPSG:32654")

    assert len(deduplicate_edges(edges)) == 2
