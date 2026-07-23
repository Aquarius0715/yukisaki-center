"""PostGIS and pgRouting database boundary."""

from __future__ import annotations

import json
import os
from typing import Any

from .config import (
    BRIDGE_PENALTY_S,
    COST_PROFILES,
    K_SHORTEST_PATHS,
    MISSING_SCORE_PENALTY_RATIO,
    NON_MAIN_ROAD_PENALTY_S,
    STALE_PLOW_PENALTY_S,
    STEEP_ROAD_PENALTY_S,
    UNKNOWN_ACCESS_PENALTY_RATIO,
)
from .models import Point, RouteRequest

_SECRETS_CLIENT = None
_DATABASE_SECRET = None


class GraphUnavailableError(RuntimeError):
    pass


class PointNotOnRoadError(ValueError):
    pass


class RouteNotFoundError(LookupError):
    pass


def secrets_client():
    global _SECRETS_CLIENT
    if _SECRETS_CLIENT is None:
        import boto3

        _SECRETS_CLIENT = boto3.client("secretsmanager")
    return _SECRETS_CLIENT


def database_secret() -> dict[str, Any]:
    global _DATABASE_SECRET
    if _DATABASE_SECRET is None:
        response = secrets_client().get_secret_value(SecretId=os.environ["DATABASE_SECRET_ARN"])
        _DATABASE_SECRET = json.loads(response["SecretString"])
    return _DATABASE_SECRET


def connect_database():
    import psycopg

    secret = database_secret()
    return psycopg.connect(
        host=secret["host"], port=secret.get("port", 5432),
        dbname=secret.get("dbname", os.environ.get("DATABASE_NAME", "yukisaki")),
        user=secret["username"], password=secret["password"], sslmode="require",
        connect_timeout=10, options="-c statement_timeout=15000",
    )


class RoutingRepository:
    def __init__(self, connection_factory=connect_database):
        self._connection_factory = connection_factory

    @staticmethod
    def _active_versions(cursor, reference_time) -> tuple[str, str, str]:
        cursor.execute(
            "SELECT graph_version FROM routing_graph_state WHERE singleton = true"
        )
        graph = cursor.fetchone()
        if not graph:
            raise GraphUnavailableError("routing graph has not been loaded")
        cursor.execute(
            """SELECT rule_version, max(data_timestamp)
               FROM drivability_scores
               WHERE data_timestamp <= %s
               GROUP BY rule_version
               ORDER BY max(data_timestamp) DESC, rule_version
               LIMIT 1""",
            (reference_time,),
        )
        score = cursor.fetchone()
        if not score:
            raise GraphUnavailableError("drivability score snapshot is unavailable")
        return str(graph[0]), str(score[0]), score[1].isoformat()

    @staticmethod
    def _snap(cursor, point: Point, graph_version: str, max_distance_m: float) -> dict[str, Any]:
        cursor.execute(
            """WITH input AS (
                 SELECT ST_SetSRID(ST_Point(%s, %s), 4326) AS geometry
               )
               SELECT n.node_id, n.source_node_key,
                      ST_Y(n.geometry), ST_X(n.geometry),
                      ST_Distance(n.geometry::geography, input.geometry::geography) AS distance_m
               FROM routing_nodes n, input
               WHERE n.graph_version = %s
               ORDER BY n.geometry <-> input.geometry
               LIMIT 1""",
            (point.longitude, point.latitude, graph_version),
        )
        row = cursor.fetchone()
        if not row or float(row[4]) > max_distance_m:
            raise PointNotOnRoadError("point is more than the maximum snap distance from a road")
        return {
            "node_id": int(row[0]), "node_key": row[1],
            "latitude": float(row[2]), "longitude": float(row[3]),
            "distance_m": round(float(row[4]), 2),
        }

    @staticmethod
    def _prepare_cost_edges(cursor, request: RouteRequest, graph_version: str, score_rule_version: str) -> None:
        profile = COST_PROFILES[request.mode]
        avoid_steep = "steep_road" in request.options.avoid
        avoid_bridge = "bridge" in request.options.avoid
        prefer_main = "main_road" in request.options.prefer
        prefer_plowed = "recently_plowed" in request.options.prefer
        cursor.execute("DROP TABLE IF EXISTS route_cost_edges")
        cursor.execute(
            """CREATE TEMP TABLE route_cost_edges ON COMMIT DROP AS
               SELECT e.edge_id AS id, e.source, e.target,
                 CASE WHEN e.access_status = 'closed' THEN -1::float8 ELSE
                   e.base_travel_time_s::float8
                   * (1
                      + %s * COALESCE((100 - score.score) / 100.0, %s)
                      + %s * COALESCE(1 - score.confidence, 1)
                      + CASE WHEN e.access_status = 'unknown' THEN %s ELSE 0 END)
                   + CASE WHEN %s AND COALESCE(e.max_slope_percent, 0) >= 5 THEN %s ELSE 0 END
                   + CASE WHEN %s AND e.bridge THEN %s ELSE 0 END
                   + CASE WHEN %s AND COALESCE(e.road_type, '') NOT IN
                       ('motorway', 'trunk', 'primary', 'secondary') THEN %s ELSE 0 END
                   + CASE WHEN %s AND
                       (passage.observed_at IS NULL OR passage.observed_at < %s - interval '180 minutes')
                       THEN %s ELSE 0 END
                 END AS cost,
                 CASE WHEN e.reverse_travel_time_s IS NULL OR e.access_status = 'closed' THEN -1::float8 ELSE
                   e.reverse_travel_time_s::float8
                   * (1
                      + %s * COALESCE((100 - score.score) / 100.0, %s)
                      + %s * COALESCE(1 - score.confidence, 1)
                      + CASE WHEN e.access_status = 'unknown' THEN %s ELSE 0 END)
                   + CASE WHEN %s AND COALESCE(e.max_slope_percent, 0) >= 5 THEN %s ELSE 0 END
                   + CASE WHEN %s AND e.bridge THEN %s ELSE 0 END
                   + CASE WHEN %s AND COALESCE(e.road_type, '') NOT IN
                       ('motorway', 'trunk', 'primary', 'secondary') THEN %s ELSE 0 END
                   + CASE WHEN %s AND
                       (passage.observed_at IS NULL OR passage.observed_at < %s - interval '180 minutes')
                       THEN %s ELSE 0 END
                 END AS reverse_cost
               FROM routing_edges e
               LEFT JOIN LATERAL (
                 SELECT d.score, d.confidence
                 FROM drivability_scores d
                 WHERE d.segment_id = e.segment_id
                   AND d.rule_version = %s AND d.data_timestamp <= %s
                 ORDER BY d.data_timestamp DESC LIMIT 1
               ) score ON true
               LEFT JOIN LATERAL (
                 SELECT p.observed_at
                 FROM snowplow_segment_passages p
                 WHERE p.segment_id = e.segment_id AND p.observed_at <= %s
                 ORDER BY p.observed_at DESC LIMIT 1
               ) passage ON true
               WHERE e.graph_version = %s""",
            (
                profile["alpha"], MISSING_SCORE_PENALTY_RATIO, profile["beta"],
                UNKNOWN_ACCESS_PENALTY_RATIO,
                avoid_steep, STEEP_ROAD_PENALTY_S, avoid_bridge, BRIDGE_PENALTY_S,
                prefer_main, NON_MAIN_ROAD_PENALTY_S,
                prefer_plowed, request.reference_time, STALE_PLOW_PENALTY_S,
                profile["alpha"], MISSING_SCORE_PENALTY_RATIO, profile["beta"],
                UNKNOWN_ACCESS_PENALTY_RATIO,
                avoid_steep, STEEP_ROAD_PENALTY_S, avoid_bridge, BRIDGE_PENALTY_S,
                prefer_main, NON_MAIN_ROAD_PENALTY_S,
                prefer_plowed, request.reference_time, STALE_PLOW_PENALTY_S,
                score_rule_version, request.reference_time, request.reference_time, graph_version,
            ),
        )
        cursor.execute("CREATE INDEX ON route_cost_edges (id)")

    @staticmethod
    def _path_rows(cursor, start_node: int, end_node: int, request: RouteRequest, score_rule_version: str):
        cursor.execute(
            """WITH paths AS (
                 SELECT * FROM pgr_KSP(
                   'SELECT id, source, target, cost, reverse_cost FROM route_cost_edges',
                   %s::bigint, %s::bigint, %s, directed := true
                 )
               )
               SELECT p.path_id, p.path_seq, p.node, p.edge, p.cost, p.agg_cost,
                      e.segment_id, e.source, e.target,
                      ST_AsGeoJSON(e.geometry)::jsonb, e.length_m, e.base_travel_time_s,
                      e.road_type, e.max_slope_percent, e.bridge, e.tunnel,
                      score.score, score.confidence, score.factors,
                      score.is_simulated AS score_is_simulated,
                      snow.snow_pipe, snow.operation_status,
                      passage.observed_at, e.is_simulated AS edge_is_simulated
               FROM paths p
               JOIN routing_edges e ON e.edge_id = p.edge
               LEFT JOIN LATERAL (
                 SELECT d.score, d.confidence, d.factors, d.is_simulated
                 FROM drivability_scores d
                 WHERE d.segment_id = e.segment_id
                   AND d.rule_version = %s AND d.data_timestamp <= %s
                 ORDER BY d.data_timestamp DESC LIMIT 1
               ) score ON true
               LEFT JOIN latest_snow_pipe_status snow ON snow.segment_id = e.segment_id
               LEFT JOIN LATERAL (
                 SELECT sp.observed_at
                 FROM snowplow_segment_passages sp
                 WHERE sp.segment_id = e.segment_id AND sp.observed_at <= %s
                 ORDER BY sp.observed_at DESC LIMIT 1
               ) passage ON true
               ORDER BY p.path_id, p.path_seq""",
            (
                start_node, end_node, K_SHORTEST_PATHS,
                score_rule_version, request.reference_time, request.reference_time,
            ),
        )
        columns = [description.name for description in cursor.description]
        return [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]

    def plan(self, request: RouteRequest, max_snap_distance_m: float) -> dict[str, Any]:
        with self._connection_factory() as connection, connection.cursor() as cursor:
            graph_version, score_rule_version, data_timestamp = self._active_versions(
                cursor, request.reference_time,
            )
            origin = self._snap(cursor, request.origin, graph_version, max_snap_distance_m)
            destination = self._snap(cursor, request.destination, graph_version, max_snap_distance_m)
            self._prepare_cost_edges(cursor, request, graph_version, score_rule_version)
            rows = self._path_rows(
                cursor, origin["node_id"], destination["node_id"], request, score_rule_version,
            )
            if not rows:
                raise RouteNotFoundError("no route satisfies the current graph and restrictions")
            return {
                "graph_version": graph_version,
                "score_rule_version": score_rule_version,
                "data_timestamp": data_timestamp,
                "origin": origin,
                "destination": destination,
                "rows": rows,
            }
