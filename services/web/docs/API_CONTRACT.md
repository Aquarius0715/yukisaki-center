# Webから利用する地図API契約

外部契約の正本はリポジトリの `docs/architecture/map-api-design.md` と `services/api/docs/contract.md`。Web実装型は `src/api/contracts.ts`、外部GeoJSONから画面内部型への変換は `src/api/mapApiAdapter.ts` に置く。Webは指数・危険理由を再計算しない。

## Map API

| Method | Path | Webでの用途 |
|---|---|---|
| GET | `/healthz` | LambdaのLiveness確認 |
| GET | `/v1/map/snapshot?bbox=west,south,east,north&limit=3000` | 初回の道路・除雪車一括取得 |
| GET | `/v1/road-segments?bbox=...&limit=3000` | 道路だけを取得する場合の補助エンドポイント |
| GET | `/v1/road-segments/{id}` | 道路区間1件 |
| GET | `/v1/snowplows` | 初回後、5秒間隔の最新位置取得 |

初回snapshotは `schema_version`, `data_timestamp`, `confidence`, `is_simulated`, `demo`, `roads`, `snowplows` を返す。道路はLineStringまたはMultiLineStringで、`segment_id`, `drivability_score`, `score_factors`, `snow_pipe`, `snow_pipe_operation_status`, `last_plowed_at`, `data_timestamp`, `is_simulated` を画面へ反映する。

初回snapshotだけはコールドスタートとJSON解析を考慮して30秒の通信上限を使用する。Apple MapKit JSへは詳細な根拠オブジェクトを複製せず、描画に必要な指数、消雪パイプ状態、除雪状態、勾配だけを渡す。詳細の根拠はReact側に保持する。

除雪車はPoint GeoJSONで、`vehicle_id`をマーカーキー、`matched_segment_id`を道路との関連キー、`heading_degrees`をアイコンの向きに使う。新しい位置は実受信時刻を表す`data_timestamp`で判定し、未提供の場合だけ`observed_at`へフォールバックする。これにより、固定デモ時刻へ戻るシミュレーター再起動後も直ちに新しい位置へ更新する。

地図の移動・拡大縮小が終わると、400ミリ秒のデバウンス後に現在の表示範囲を`bbox`としてsnapshotを再取得する。古いリクエストが後から完了しても画面へ反映しない。`truncated: true`は内部で道路上限到達として保持するが、固定警告は表示せず、利用者が地図を拡大すると自動的に対象範囲を狭めて再取得する。`is_simulated: true`はデモデータとして画面に明示する。503または429では最後の正常値を保持し、「更新停止」を表示して値を推定しない。

## Map API対象外

経路探索、目的地検索、天気、走行軌跡・本日走行距離は現在のMap APIに含まれない。Webデモではこれらだけをモックとして維持し、API由来情報と区別する。

## エラー

```json
{ "error": { "code": "service_unavailable", "message": "safe public message" } }
```

400は入力不正、404は対象なし、405はGET以外、503はRDS停止または一時障害。内部例外、DB接続情報、Secret ARNは表示しない。
