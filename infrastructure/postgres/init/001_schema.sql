-- S3 is the source of truth.  These tables are a rebuildable serving projection.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgrouting;

CREATE TABLE IF NOT EXISTS data_load_runs (
  run_id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  source_key TEXT NOT NULL,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  record_count INTEGER NOT NULL CHECK (record_count >= 0)
);

CREATE TABLE IF NOT EXISTS weather_hourly_windows (
  weather_window_record_id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  location_name TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  reference_time TIMESTAMPTZ NOT NULL,
  valid_time TIMESTAMPTZ NOT NULL,
  relative_hour SMALLINT NOT NULL CHECK (relative_hour BETWEEN -3 AND 3),
  data_kind TEXT NOT NULL CHECK (data_kind IN ('observed', 'forecast')),
  temperature_c NUMERIC,
  relative_humidity_percent NUMERIC,
  precipitation_mm NUMERIC,
  snowfall_cm NUMERIC,
  snow_depth_m NUMERIC,
  weather_code INTEGER,
  wind_speed_kmh NUMERIC,
  wind_gusts_kmh NUMERIC,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  run_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (location_id, reference_time, valid_time, data_kind)
);

CREATE INDEX IF NOT EXISTS weather_hourly_windows_lookup_idx
  ON weather_hourly_windows (location_id, reference_time, relative_hour);

-- Geometry is initially retained as GeoJSON. The production serving DB adds
-- PostGIS and pgRouting before route search is enabled.
CREATE TABLE IF NOT EXISTS road_segments (
  segment_id TEXT PRIMARY KEY,
  geometry_geojson JSONB NOT NULL,
  min_longitude DOUBLE PRECISION,
  min_latitude DOUBLE PRECISION,
  max_longitude DOUBLE PRECISION,
  max_latitude DOUBLE PRECISION,
  road_name TEXT,
  road_type TEXT,
  length_m NUMERIC,
  max_slope_percent NUMERIC,
  routing_edge_id BIGINT,
  source_node_id BIGINT,
  target_node_id BIGINT,
  source_node_key TEXT,
  target_node_key TEXT,
  routing_oneway BOOLEAN NOT NULL DEFAULT false,
  speed_limit_kmh NUMERIC,
  effective_speed_kmh NUMERIC,
  base_travel_time_s NUMERIC,
  reverse_travel_time_s NUMERIC,
  access_status TEXT NOT NULL DEFAULT 'unknown',
  bridge BOOLEAN NOT NULL DEFAULT false,
  tunnel BOOLEAN NOT NULL DEFAULT false,
  graph_version TEXT,
  source TEXT NOT NULL,
  source_version TEXT,
  snapshot_date DATE NOT NULL,
  is_simulated BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS road_segments_bbox_idx
  ON road_segments (min_longitude, max_longitude, min_latitude, max_latitude);

CREATE TABLE IF NOT EXISTS routing_nodes (
  node_id BIGINT PRIMARY KEY,
  source_node_key TEXT UNIQUE NOT NULL,
  geometry geometry(Point, 4326) NOT NULL,
  graph_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS routing_nodes_geometry_idx
  ON routing_nodes USING GIST (geometry);

CREATE TABLE IF NOT EXISTS routing_edges (
  edge_id BIGINT PRIMARY KEY,
  segment_id TEXT UNIQUE NOT NULL REFERENCES road_segments(segment_id),
  source BIGINT NOT NULL REFERENCES routing_nodes(node_id),
  target BIGINT NOT NULL REFERENCES routing_nodes(node_id),
  geometry geometry(LineString, 4326) NOT NULL,
  length_m NUMERIC NOT NULL CHECK (length_m > 0),
  road_type TEXT,
  speed_limit_kmh NUMERIC,
  effective_speed_kmh NUMERIC NOT NULL CHECK (effective_speed_kmh > 0),
  base_travel_time_s NUMERIC NOT NULL CHECK (base_travel_time_s > 0),
  reverse_travel_time_s NUMERIC,
  oneway BOOLEAN NOT NULL,
  access_status TEXT NOT NULL CHECK (access_status IN ('open', 'closed', 'unknown')),
  bridge BOOLEAN NOT NULL,
  tunnel BOOLEAN NOT NULL,
  max_slope_percent NUMERIC,
  graph_version TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS routing_edges_geometry_idx
  ON routing_edges USING GIST (geometry);
CREATE INDEX IF NOT EXISTS routing_edges_source_idx ON routing_edges (source);
CREATE INDEX IF NOT EXISTS routing_edges_target_idx ON routing_edges (target);
CREATE INDEX IF NOT EXISTS routing_edges_graph_version_idx ON routing_edges (graph_version);

CREATE TABLE IF NOT EXISTS routing_graph_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  graph_version TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snow_pipe_history (
  segment_id TEXT NOT NULL REFERENCES road_segments(segment_id),
  snow_pipe BOOLEAN NOT NULL,
  operation_status TEXT NOT NULL CHECK (operation_status IN ('active', 'inactive', 'unknown')),
  effectiveness NUMERIC NOT NULL CHECK (effectiveness BETWEEN 0 AND 1),
  valid_from TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  run_id TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL,
  PRIMARY KEY (segment_id, valid_from, rule_version)
);

CREATE OR REPLACE VIEW latest_snow_pipe_status AS
SELECT DISTINCT ON (segment_id)
  segment_id, snow_pipe, operation_status, effectiveness, valid_from,
  source, rule_version, run_id, is_simulated
FROM snow_pipe_history
ORDER BY segment_id, valid_from DESC, ingested_at DESC;

DROP VIEW IF EXISTS road_segments_enriched;
CREATE VIEW road_segments_enriched AS
SELECT r.segment_id, r.geometry_geojson, r.road_name, r.road_type,
       r.length_m, r.max_slope_percent, r.source, r.source_version,
       r.snapshot_date, r.is_simulated,
       s.snow_pipe, s.operation_status, s.effectiveness,
       s.valid_from AS snow_pipe_updated_at, s.source AS snow_pipe_source,
       s.rule_version AS snow_pipe_rule_version,
       s.is_simulated AS snow_pipe_is_simulated,
       r.min_longitude, r.min_latitude, r.max_longitude, r.max_latitude
FROM road_segments r
LEFT JOIN latest_snow_pipe_status s USING (segment_id);

CREATE TABLE IF NOT EXISTS snowplow_vehicles (
  vehicle_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  source TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS snowplow_positions_latest (
  vehicle_id TEXT PRIMARY KEY REFERENCES snowplow_vehicles(vehicle_id),
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  speed_kmh NUMERIC NOT NULL,
  heading_degrees NUMERIC NOT NULL,
  accuracy_m NUMERIC NOT NULL,
  operation TEXT NOT NULL,
  matched_segment_id TEXT NOT NULL REFERENCES road_segments(segment_id),
  match_distance_m NUMERIC NOT NULL,
  run_id TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS snowplow_segment_passages (
  event_id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES snowplow_vehicles(vehicle_id),
  segment_id TEXT NOT NULL REFERENCES road_segments(segment_id),
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  operation TEXT NOT NULL,
  speed_kmh NUMERIC NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  match_distance_m NUMERIC NOT NULL,
  ground_truth_segment_id TEXT,
  ground_truth_match BOOLEAN,
  source TEXT NOT NULL,
  run_id TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS snowplow_passages_segment_time_idx
  ON snowplow_segment_passages (segment_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS drivability_scores (
  segment_id TEXT NOT NULL REFERENCES road_segments(segment_id),
  data_timestamp TIMESTAMPTZ NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  confidence NUMERIC NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  factors JSONB NOT NULL,
  rule_version TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (segment_id, data_timestamp, rule_version)
);
