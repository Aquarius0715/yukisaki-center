-- S3 is the source of truth.  These tables are a rebuildable serving projection.

CREATE TABLE IF NOT EXISTS data_load_runs (
  run_id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  source_key TEXT NOT NULL,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  record_count INTEGER NOT NULL CHECK (record_count >= 0)
);

CREATE TABLE IF NOT EXISTS weather_records (
  weather_record_id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  title TEXT,
  bulletin_url TEXT NOT NULL,
  data_timestamp TIMESTAMPTZ NOT NULL,
  content TEXT,
  author TEXT,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  run_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  is_simulated BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS weather_records_data_timestamp_idx
  ON weather_records (data_timestamp DESC);

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
