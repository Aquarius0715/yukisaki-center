# GPSイベント契約

KinesisのPartition Keyは`vehicle_id`とする。

```json
{
  "schema_version": "1.0.0",
  "event_id": "UUID",
  "run_id": "gps-sim-UUID",
  "vehicle_id": "snowplow-01",
  "observed_at": "2026-01-23T12:00:00+09:00",
  "received_at": "実送信時刻",
  "latitude": 37.442762,
  "longitude": 138.790865,
  "speed_kmh": 18.0,
  "heading_degrees": 120.0,
  "accuracy_m": 5.0,
  "operation": "snow_removal",
  "ground_truth_segment_id": "道路区間ID",
  "source": "yukisaki-gps-simulator",
  "is_simulated": true
}
```
