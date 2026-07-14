"""OpenStreetMap acquisition isolated from geometry processing."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import geopandas as gpd
import osmnx as ox

LOGGER = logging.getLogger(__name__)

ROAD_DETAIL_TAGS = {
    "access", "bridge", "cycleway", "highway", "junction", "lanes",
    "lanes:backward", "lanes:forward", "lit", "maxspeed", "name", "oneway",
    "parking", "ref", "service", "sidewalk", "surface", "tunnel", "width",
}


@dataclass(frozen=True)
class AcquiredNetwork:
    """A fetched graph and the method that obtained it."""

    graph: Any
    method: str


def fetch_drive_network(place_name: str, lat: float | None, lon: float | None, radius_m: float) -> AcquiredNetwork:
    """Fetch driveable roads, first through place polygon then a point fallback."""
    # OSMnx otherwise discards tags it does not consider essential for routing.
    # Keep snow/drivability attributes so the edge table remains useful downstream.
    ox.settings.useful_tags_way = sorted(set(ox.settings.useful_tags_way) | ROAD_DETAIL_TAGS)
    try:
        place: gpd.GeoDataFrame = ox.geocode_to_gdf(place_name)
        if place.empty:
            raise ValueError("geocoder returned no polygon")
        graph = ox.graph_from_polygon(place.geometry.iloc[0], network_type="drive")
        LOGGER.info("Acquired OSM network using place polygon")
        return AcquiredNetwork(graph, "place_polygon")
    except Exception as error:
        LOGGER.warning("Place polygon lookup failed for %s: %s", place_name, error)
        if lat is None or lon is None:
            raise RuntimeError(
                "Place polygon lookup failed and FALLBACK_CENTER_LAT/LON are not configured."
            ) from error
        try:
            graph = ox.graph_from_point((lat, lon), dist=radius_m, network_type="drive")
        except Exception as fallback_error:
            raise RuntimeError("Unable to fetch OSM drive network using fallback coordinates.") from fallback_error
        LOGGER.info("Acquired OSM network using fallback point (radius %.0f m)", radius_m)
        return AcquiredNetwork(graph, "fallback_point_radius")


def graph_edges(graph: Any) -> gpd.GeoDataFrame:
    """Convert an OSMnx graph to edges with explicit node/key columns."""
    edges = ox.graph_to_gdfs(graph, nodes=False, edges=True).reset_index()
    if edges.empty:
        raise RuntimeError("OSM returned zero driveable road edges.")
    return edges

