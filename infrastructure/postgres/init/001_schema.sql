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
  road_type TEXT,
  length_m NUMERIC,
  max_slope_percent NUMERIC,
  source TEXT NOT NULL,
  source_version TEXT,
  snapshot_date DATE NOT NULL,
  is_simulated BOOLEAN NOT NULL DEFAULT false
);

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
