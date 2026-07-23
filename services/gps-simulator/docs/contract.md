# GPSイベント契約

EventBridgeの`source`は`com.yukisaki.gps-simulator`、`detail-type`は`Snowplow GPS Position`とする。

シミュレーターは長岡市全域のcurated道路グラフを全域走査し、連続した道路上の移動として3台へ均等分割する。3台の経路の和集合が入力スナップショットの全道路区間を含むことをテストで保証する。`observed_at`は固定デモシナリオ内の時刻、`received_at`は実際にイベントを送信した時刻であり、再起動後の最新判定には`received_at`を使う。

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
