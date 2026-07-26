"""Versioned, non-secret routing cost configuration."""

from __future__ import annotations

COST_CONFIG_VERSION = "route-cost-v2"
DEMO_REFERENCE_TIME = "2026-01-23T12:00:00+09:00"
NAGAOKA_BOUNDS = (138.643056, 37.176389, 139.124444, 37.710278)
# Place-search results can point to the centre of a large facility or parcel
# instead of its road entrance. Keep the point inside a bounded catchment while
# allowing those representative coordinates to reach the nearest road.
MAX_SNAP_DISTANCE_M = 500.0
MAX_CANDIDATES = 3
# pgr_KSP cost scales with K on the small demo RDS instance; 8 pushed longer
# in-city routes past the statement timeout. 5 still leaves enough raw
# candidates for the diversity and comparison-mode selection passes.
K_SHORTEST_PATHS = 5
# Restrict pgRouting to a rectangle around the two snapped points. The second,
# wider margin is only used when the normal urban corridor has no connected
# route, such as when a river or mountain requires a larger detour.
ROUTE_CORRIDOR_MARGIN_DEGREES = (0.03, 0.08)
# KSP candidates commonly share most of a long route and differ only around
# one junction. Treating 80% overlap as duplicate was too aggressive for the
# Nagaoka graph, so require 95% overlap before the diversity pass rejects one.
SIMILARITY_THRESHOLD = 0.95
COMPARISON_OVERLAP_LIMITS = (
    (0.75, 0.60),
    (0.85, 0.75),
)

COST_PROFILES = {
    "time_priority": {"alpha": 0.2, "beta": 0.2, "basis": "time"},
    "balanced": {"alpha": 1.0, "beta": 0.5, "basis": "time"},
    "drivability_priority": {"alpha": 3.0, "beta": 1.0, "basis": "time"},
    # Convert distance to seconds at a fixed 50km/h only to keep the public
    # weighted_cost_s unit stable. Actual road speeds do not affect this mode.
    "distance_priority": {"alpha": 0.2, "beta": 0.2, "basis": "distance"},
}

MISSING_SCORE_PENALTY_RATIO = 0.75
UNKNOWN_ACCESS_PENALTY_RATIO = 0.25
STEEP_ROAD_PENALTY_S = 300.0
BRIDGE_PENALTY_S = 300.0
NON_MAIN_ROAD_PENALTY_S = 15.0
STALE_PLOW_PENALTY_S = 20.0
