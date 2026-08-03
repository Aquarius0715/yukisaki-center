"""PostGIS and pgRouting database boundary."""

from __future__ import annotations

import json
import hashlib
import logging
import os
import time
from collections import defaultdict
from typing import Any

from .config import (
    BRIDGE_PENALTY_S,
    COST_CONFIG_VERSION,
    COST_PROFILES,
    K_SHORTEST_PATHS,
    MISSING_SCORE_PENALTY_RATIO,
    NON_MAIN_ROAD_PENALTY_S,
    ROUTE_CORRIDOR_MARGIN_DEGREES,
    STALE_PLOW_PENALTY_S,
    STEEP_ROAD_PENALTY_S,
    UNKNOWN_ACCESS_PENALTY_RATIO,
)
from .models import Point, RouteRequest

_SECRETS_CLIENT = None
_DATABASE_SECRET = None
LOGGER = logging.getLogger(__name__)


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
        # Leave headroom under the Lambda function's 29s timeout (the most
        # available before API Gateway's 30s hard cap on HTTP API integrations)
        # so pgr_KSP on longer in-city routes can finish instead of being cut
        # off early.
        connect_timeout=10, options="-c statement_timeout=26000",
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
               ),
               nearest_edge AS MATERIALIZED (
                 SELECT e.source, e.target,
                        ST_Distance(
                          e.geometry::geography,
                          input.geometry::geography
                        ) AS road_distance_m
                 FROM routing_edges e, input
                 WHERE e.graph_version = %s
                 ORDER BY e.geometry <-> input.geometry
                 LIMIT 1
               )
               SELECT n.node_id, n.source_node_key,
                      ST_Y(n.geometry), ST_X(n.geometry),
                      ST_Distance(
                        n.geometry::geography,
                        input.geometry::geography
                      ) AS node_distance_m,
                      nearest_edge.road_distance_m
               FROM nearest_edge
               JOIN routing_nodes n
                 ON n.node_id IN (nearest_edge.source, nearest_edge.target)
               CROSS JOIN input
               ORDER BY node_distance_m
               LIMIT 1""",
            (point.longitude, point.latitude, graph_version),
        )
        row = cursor.fetchone()
        if not row or float(row[5]) > max_distance_m:
            raise PointNotOnRoadError("point is more than the maximum snap distance from a road")
        return {
            "node_id": int(row[0]), "node_key": row[1],
            "latitude": float(row[2]), "longitude": float(row[3]),
            "distance_m": round(float(row[4]), 2),
            "road_distance_m": round(float(row[5]), 2),
        }

    @staticmethod
    def _cost_cache_key(
        request: RouteRequest,
        graph_version: str,
        score_rule_version: str,
        score_data_timestamp: str,
    ) -> str:
        payload = {
            "graph_version": graph_version,
            "score_rule_version": score_rule_version,
            "score_data_timestamp": score_data_timestamp,
            "cost_config_version": COST_CONFIG_VERSION,
            "reference_time": request.reference_time.isoformat(),
            "mode": request.mode,
            "avoid": sorted(request.options.avoid),
            "prefer": sorted(request.options.prefer),
        }
        digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        return f"route-cost-{digest[:32]}"

    @staticmethod
    def _ensure_cost_cache_schema(cursor) -> None:
        cursor.execute(
            """CREATE TABLE IF NOT EXISTS routing_cost_snapshots (
                 cache_key TEXT PRIMARY KEY,
                 graph_version TEXT NOT NULL,
                 score_rule_version TEXT NOT NULL,
                 score_data_timestamp TIMESTAMPTZ NOT NULL,
                 reference_time TIMESTAMPTZ NOT NULL,
                 mode TEXT NOT NULL,
                 avoid_conditions JSONB NOT NULL,
                 prefer_conditions JSONB NOT NULL,
                 edge_count INTEGER NOT NULL DEFAULT 0,
                 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
               )"""
        )
        cursor.execute(
            """CREATE TABLE IF NOT EXISTS routing_cost_edges_cache (
                 cache_key TEXT NOT NULL
                   REFERENCES routing_cost_snapshots(cache_key) ON DELETE CASCADE,
                 id BIGINT NOT NULL,
                 source BIGINT NOT NULL,
                 target BIGINT NOT NULL,
                 cost DOUBLE PRECISION NOT NULL,
                 reverse_cost DOUBLE PRECISION NOT NULL,
                 PRIMARY KEY (cache_key, id)
               )"""
        )
        cursor.execute(
            """CREATE INDEX IF NOT EXISTS routing_cost_edges_cache_source_idx
               ON routing_cost_edges_cache (cache_key, source)"""
        )
        cursor.execute(
            """CREATE INDEX IF NOT EXISTS routing_cost_edges_cache_target_idx
               ON routing_cost_edges_cache (cache_key, target)"""
        )
        cursor.execute(
            """CREATE INDEX IF NOT EXISTS drivability_scores_route_lookup_idx
               ON drivability_scores (segment_id, rule_version, data_timestamp DESC)
               INCLUDE (score, confidence, factors, is_simulated)"""
        )
        cursor.execute(
            """CREATE INDEX IF NOT EXISTS drivability_scores_version_time_idx
               ON drivability_scores (rule_version, data_timestamp DESC)"""
        )

    @classmethod
    def _prepare_cost_edges(
        cls,
        cursor,
        request: RouteRequest,
        graph_version: str,
        score_rule_version: str,
        score_data_timestamp: str,
    ) -> tuple[str, bool]:
        profile = COST_PROFILES[request.mode]
        avoid_steep = "steep_road" in request.options.avoid
        avoid_bridge = "bridge" in request.options.avoid
        prefer_main = "main_road" in request.options.prefer
        prefer_plowed = "recently_plowed" in request.options.prefer
        if prefer_plowed:
            passage_join = """
               LEFT JOIN LATERAL (
                 SELECT p.observed_at
                 FROM snowplow_segment_passages p
                 WHERE p.segment_id = e.segment_id
                   AND p.observed_at <= %s
                 ORDER BY p.observed_at DESC LIMIT 1
               ) passage ON true
            """
            passage_parameters: tuple[Any, ...] = (request.reference_time,)
        else:
            passage_join = """
               LEFT JOIN LATERAL (
                 SELECT NULL::timestamptz AS observed_at
               ) passage ON true
            """
            passage_parameters = ()
        forward_basis = (
            "e.length_m::float8 / 13.8888888889"
            if profile["basis"] == "distance"
            else "e.base_travel_time_s::float8"
        )
        reverse_basis = (
            "e.length_m::float8 / 13.8888888889"
            if profile["basis"] == "distance"
            else "e.reverse_travel_time_s::float8"
        )
        cache_key = cls._cost_cache_key(
            request,
            graph_version,
            score_rule_version,
            score_data_timestamp,
        )
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (cache_key,),
        )
        cursor.execute(
            "SELECT edge_count FROM routing_cost_snapshots WHERE cache_key = %s",
            (cache_key,),
        )
        cached = cursor.fetchone()
        if cached and int(cached[0]) > 0:
            return cache_key, True

        cursor.execute(
            """INSERT INTO routing_cost_snapshots (
                 cache_key, graph_version, score_rule_version,
                 score_data_timestamp, reference_time, mode,
                 avoid_conditions, prefer_conditions
               )
               VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)
               ON CONFLICT (cache_key) DO NOTHING""",
            (
                cache_key,
                graph_version,
                score_rule_version,
                score_data_timestamp,
                request.reference_time,
                request.mode,
                json.dumps(sorted(request.options.avoid)),
                json.dumps(sorted(request.options.prefer)),
            ),
        )
        cursor.execute(
            f"""WITH latest_scores AS MATERIALIZED (
                 SELECT DISTINCT ON (d.segment_id)
                   d.segment_id, d.score, d.confidence
                 FROM drivability_scores d
                 WHERE d.rule_version = %s
                   AND d.data_timestamp <= %s
                 ORDER BY d.segment_id, d.data_timestamp DESC
               )
               INSERT INTO routing_cost_edges_cache (
                 cache_key, id, source, target, cost, reverse_cost
               )
               SELECT %s, e.edge_id, e.source, e.target,
                 CASE WHEN e.access_status = 'closed' THEN -1::float8 ELSE
                   {forward_basis}
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
                   {reverse_basis}
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
               LEFT JOIN latest_scores score ON score.segment_id = e.segment_id
               {passage_join}
               WHERE e.graph_version = %s
               ON CONFLICT (cache_key, id) DO NOTHING""",
            (
                score_rule_version,
                request.reference_time,
                cache_key,
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
                *passage_parameters,
                graph_version,
            ),
        )
        cursor.execute(
            """UPDATE routing_cost_snapshots
               SET edge_count = (
                 SELECT count(*)
                 FROM routing_cost_edges_cache
                 WHERE cache_key = %s
               )
               WHERE cache_key = %s""",
            (cache_key, cache_key),
        )
        return cache_key, False

    @staticmethod
    def _path_rows(
        cursor,
        start_node: int,
        end_node: int,
        request: RouteRequest,
        score_rule_version: str,
        cache_key: str,
        graph_version: str,
    ):
        for margin_degrees in ROUTE_CORRIDOR_MARGIN_DEGREES:
            west = min(request.origin.longitude, request.destination.longitude) - margin_degrees
            south = min(request.origin.latitude, request.destination.latitude) - margin_degrees
            east = max(request.origin.longitude, request.destination.longitude) + margin_degrees
            north = max(request.origin.latitude, request.destination.latitude) + margin_degrees
            cursor.execute("DROP TABLE IF EXISTS route_cost_edges")
            cursor.execute(
                """CREATE TEMP TABLE route_cost_edges ON COMMIT DROP AS
                   SELECT c.id, c.source, c.target, c.cost, c.reverse_cost
                   FROM routing_edges e
                   JOIN routing_cost_edges_cache c
                     ON c.cache_key = %s AND c.id = e.edge_id
                   WHERE e.graph_version = %s
                     AND e.geometry && ST_MakeEnvelope(%s, %s, %s, %s, 4326)""",
                (cache_key, graph_version, west, south, east, north),
            )
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
                          rs.road_name,
                          score.score, score.confidence, score.factors,
                          score.is_simulated AS score_is_simulated,
                          snow.snow_pipe, snow.operation_status,
                          passage.observed_at, e.is_simulated AS edge_is_simulated
                   FROM paths p
                   JOIN routing_edges e ON e.edge_id = p.edge
                   LEFT JOIN road_segments rs ON rs.segment_id = e.segment_id
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
            rows = [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]
            if rows:
                LOGGER.info("route corridor selected margin_degrees=%.2f", margin_degrees)
                return rows
        return []

    def fetch_latest_passages(
        self,
        segment_ids: list[str],
        before_time: Any,
    ) -> dict[str, Any]:
        """Most recent snow_removal passage at or before `before_time`, per segment.

        Feeds the departure-time predictor's "elapsed since last plow" input,
        so it only ever sees passages already known as of the query's
        reference_time.
        """
        if not segment_ids:
            return {}
        with self._connection_factory() as connection, connection.cursor() as cursor:
            cursor.execute(
                """SELECT s.segment_id, latest.observed_at
                   FROM unnest(%s::text[]) AS s(segment_id)
                   LEFT JOIN LATERAL (
                     SELECT p.observed_at
                     FROM snowplow_segment_passages p
                     WHERE p.segment_id = s.segment_id
                       AND p.operation = 'snow_removal'
                       AND p.observed_at <= %s
                     ORDER BY p.observed_at DESC LIMIT 1
                   ) latest ON true""",
                (list(segment_ids), before_time),
            )
            return {
                segment_id: observed_at
                for segment_id, observed_at in cursor.fetchall()
                if observed_at is not None
            }

    def fetch_training_passage_samples(self, limit_segments: int) -> dict[str, list[Any]]:
        """Full passage history for a bounded, network-wide segment sample.

        Unlike `fetch_latest_passages`, this is not bounded by any request's
        reference_time: it trains the general plow-cadence model on whatever
        passage history is available, the same way a real deployment would
        train on past seasons rather than the specific day being queried.
        """
        with self._connection_factory() as connection, connection.cursor() as cursor:
            cursor.execute(
                """WITH candidate_segments AS (
                     SELECT segment_id
                     FROM snowplow_segment_passages
                     WHERE operation = 'snow_removal'
                     GROUP BY segment_id
                     HAVING count(*) >= 2
                     ORDER BY random()
                     LIMIT %s
                   )
                   SELECT p.segment_id, p.observed_at
                   FROM candidate_segments c
                   JOIN snowplow_segment_passages p
                     ON p.segment_id = c.segment_id AND p.operation = 'snow_removal'
                   ORDER BY p.segment_id, p.observed_at""",
                (limit_segments,),
            )
            grouped: dict[str, list[Any]] = defaultdict(list)
            for segment_id, observed_at in cursor.fetchall():
                grouped[segment_id].append(observed_at)
            return dict(grouped)

    def plan(self, request: RouteRequest, max_snap_distance_m: float) -> dict[str, Any]:
        with self._connection_factory() as connection, connection.cursor() as cursor:
            started_at = time.perf_counter()
            self._ensure_cost_cache_schema(cursor)
            connection.commit()
            schema_at = time.perf_counter()
            graph_version, score_rule_version, data_timestamp = self._active_versions(
                cursor, request.reference_time,
            )
            versions_at = time.perf_counter()
            origin = self._snap(cursor, request.origin, graph_version, max_snap_distance_m)
            origin_at = time.perf_counter()
            destination = self._snap(cursor, request.destination, graph_version, max_snap_distance_m)
            destination_at = time.perf_counter()
            cache_key, cache_hit = self._prepare_cost_edges(
                cursor,
                request,
                graph_version,
                score_rule_version,
                data_timestamp,
            )
            connection.commit()
            cache_at = time.perf_counter()
            rows = self._path_rows(
                cursor,
                origin["node_id"],
                destination["node_id"],
                request,
                score_rule_version,
                cache_key,
                graph_version,
            )
            paths_at = time.perf_counter()
            LOGGER.info(
                "route repository timings schema_ms=%d active_versions_ms=%d origin_snap_ms=%d "
                "destination_snap_ms=%d cost_cache_ms=%d path_rows_ms=%d total_ms=%d "
                "cost_cache_hit=%s cache_key=%s",
                round((schema_at - started_at) * 1000),
                round((versions_at - schema_at) * 1000),
                round((origin_at - versions_at) * 1000),
                round((destination_at - origin_at) * 1000),
                round((cache_at - destination_at) * 1000),
                round((paths_at - cache_at) * 1000),
                round((paths_at - started_at) * 1000),
                cache_hit,
                cache_key,
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
