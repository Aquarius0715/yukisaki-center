"""Versioned, non-secret routing cost configuration."""

from __future__ import annotations

COST_CONFIG_VERSION = "route-cost-v1"
DEMO_REFERENCE_TIME = "2026-01-23T12:00:00+09:00"
NAGAOKA_BOUNDS = (138.643056, 37.176389, 139.124444, 37.710278)
MAX_SNAP_DISTANCE_M = 100.0
MAX_CANDIDATES = 3
K_SHORTEST_PATHS = 10
SIMILARITY_THRESHOLD = 0.80

COST_PROFILES = {
    "time_priority": {"alpha": 0.2, "beta": 0.2},
    "balanced": {"alpha": 1.0, "beta": 0.5},
    "drivability_priority": {"alpha": 3.0, "beta": 1.0},
}

MISSING_SCORE_PENALTY_RATIO = 0.75
UNKNOWN_ACCESS_PENALTY_RATIO = 0.25
STEEP_ROAD_PENALTY_S = 300.0
BRIDGE_PENALTY_S = 300.0
NON_MAIN_ROAD_PENALTY_S = 15.0
STALE_PLOW_PENALTY_S = 20.0

