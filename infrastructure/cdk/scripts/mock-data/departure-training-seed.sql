-- Seed synthetic snowplow_segment_passages headway data for the departure-
-- time logistic regression (services/route-planning/departure_advisor.py).
--
-- Why this exists: reference_time is pinned to the fixed demo instant
-- (2026-01-23T12:00:00+09:00), so any route segment evaluated for a
-- departure-time recommendation always sees zero passage history at or
-- before that instant and falls back to the DEPARTURE_NO_HISTORY_ELAPSED_MINUTES
-- sentinel (240 minutes). The model can only use that sentinel input if its
-- training data actually observed elapsed values that large -- otherwise
-- the extrapolation guard added on 2026-08-03 correctly reports
-- insufficient_data. The real GPS simulator run captured so far only
-- produced gaps under 8 minutes (30 vehicles converging near a shared
-- starting point within the first few minutes), which is nowhere near
-- enough. This script fills that gap with clearly labelled mock data.
--
-- Gaps deliberately span up to 1200 minutes (20 hours), not just past the
-- 240-minute sentinel: a seeded segment that happens to already have real
-- burst passages around the demo reference_time (2026-08-03 production
-- verification hit exactly this) creates its own extra-long gap between
-- that real cluster and this seed's mock cluster, and 350 minutes of
-- headroom was not enough to safely cover that combined timeline in every
-- random training draw. 1200 minutes leaves comfortable margin.
--
-- Safe to re-run: every insert is idempotent (ON CONFLICT DO NOTHING), nothing
-- is deleted, and every row is explicitly is_simulated = true. To remove
-- this seed data later, see departure-training-seed-teardown.sql.

INSERT INTO snowplow_vehicles (vehicle_id, display_name, source, is_simulated)
VALUES ('mock-departure-training-seed', 'Mock Departure Training Seed', 'departure-training-seed-script', true)
ON CONFLICT (vehicle_id) DO NOTHING;

WITH seed_segments AS (
  SELECT segment_id, min_latitude, min_longitude,
         (row_number() OVER (ORDER BY segment_id) - 1) AS rn
  FROM road_segments
  WHERE min_latitude IS NOT NULL AND min_longitude IS NOT NULL
  ORDER BY segment_id
  LIMIT 80
),
-- A spread of gaps from 5 minutes up to 1200 minutes: comfortably brackets
-- the 240-minute sentinel with a wide margin on both sides, and gives the
-- model short, medium, and long examples instead of an all-or-nothing
-- boundary.
gap_choices (gap_index, gap_minutes) AS (
  VALUES (0, 5), (1, 20), (2, 45), (3, 90), (4, 150),
         (5, 240), (6, 350), (7, 500), (8, 750), (9, 1200)
),
seed_pairs AS (
  SELECT
    s.segment_id, s.min_latitude, s.min_longitude, g.gap_minutes,
    -- Stagger each segment's first pass so timestamps don't collide.
    timestamptz '2026-01-23 00:00:00+09' + (s.rn * interval '1 minute') AS first_pass
  FROM seed_segments s
  JOIN gap_choices g ON g.gap_index = s.rn % 10
)
INSERT INTO snowplow_segment_passages (
  event_id, vehicle_id, segment_id, observed_at, received_at,
  operation, speed_kmh, latitude, longitude, match_distance_m,
  source, run_id, is_simulated
)
SELECT
  'mock-departure-seed-' || p.segment_id || '-' || pass_offset,
  'mock-departure-training-seed',
  p.segment_id,
  p.first_pass + (pass_offset * p.gap_minutes) * interval '1 minute',
  p.first_pass + (pass_offset * p.gap_minutes) * interval '1 minute',
  'snow_removal',
  18.0,
  p.min_latitude,
  p.min_longitude,
  0,
  'mock-seed',
  'departure-training-seed-v1',
  true
FROM seed_pairs p, generate_series(0, 1) AS pass_offset
ON CONFLICT (event_id) DO NOTHING;

SELECT count(DISTINCT segment_id) AS seeded_segments, count(*) AS seeded_passages
FROM snowplow_segment_passages
WHERE run_id = 'departure-training-seed-v1';
