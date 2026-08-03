-- Removes the mock data inserted by departure-training-seed.sql.
-- Safe: only targets rows tagged with the dedicated run_id / vehicle_id
-- used by that script, never touches real GPS-simulator passages.

DELETE FROM snowplow_segment_passages WHERE run_id = 'departure-training-seed-v1';
DELETE FROM snowplow_vehicles WHERE vehicle_id = 'mock-departure-training-seed';
