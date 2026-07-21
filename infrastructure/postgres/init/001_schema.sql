-- S3 is the source of truth.  These tables are a rebuildable serving projection.

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
  road_name TEXT,
  road_type TEXT,
  length_m NUMERIC,
  max_slope_percent NUMERIC,
  source TEXT NOT NULL,
  source_version TEXT,
  snapshot_date DATE NOT NULL,
  is_simulated BOOLEAN NOT NULL DEFAULT false
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

CREATE OR REPLACE VIEW road_segments_enriched AS
SELECT r.*, s.snow_pipe, s.operation_status, s.effectiveness,
       s.valid_from AS snow_pipe_updated_at, s.source AS snow_pipe_source,
       s.rule_version AS snow_pipe_rule_version,
       s.is_simulated AS snow_pipe_is_simulated
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
