# 地図・除雪車API契約

全エンドポイントはHTTPSのAPI Gateway HTTP APIから公開する。`data_timestamp`、`confidence`、`is_simulated`を応答に含め、デモ用GPS・消雪パイプ・指数を実データとして扱わない。

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/healthz` | Lambdaの稼働確認 |
| GET | `/v1/road-segments` | 表示範囲の道路・指数・消雪パイプ・最終除雪をGeoJSONで取得 |
| GET | `/v1/road-segments/{id}` | 道路区間1件を取得 |
| GET | `/v1/snowplows` | 除雪車の最新位置をPoint GeoJSONで取得 |
| GET | `/v1/map/snapshot` | 初期表示用に道路と除雪車を一括取得 |

## 道路のクエリ

- `bbox=west,south,east,north`: 地図の表示範囲。省略時は長岡市全域`138.643056,37.176389,139.124444,37.710278`
- `limit=1..5000`: 1ページの最大道路件数。省略時は5,000件。Webは75件を使用する
- `cursor`: 前ページの`next_cursor`。同じ`bbox`の続きを取得する場合だけ指定する

レスポンスに続きがある場合は`truncated: true`と`next_cursor`が返る。Web地図はブラウザ保護のため、現在の表示範囲の最初のページだけを描画する。

```json
{
  "type": "FeatureCollection",
  "features": [{
    "type": "Feature",
    "id": "road-1",
    "geometry": {"type": "LineString", "coordinates": [[138.78, 37.44], [138.79, 37.45]]},
    "properties": {
      "segment_id": "road-1",
      "drivability_score": 82,
      "confidence": 0.9,
      "snow_pipe": true,
      "last_plowed_at": "2026-01-23T12:00:00+09:00",
      "data_timestamp": "2026-01-23T12:01:00+09:00",
      "is_simulated": true
    }
  }],
  "bbox": [138.643056, 37.176389, 139.124444, 37.710278],
  "count": 1,
  "truncated": false,
  "next_cursor": null,
  "data_timestamp": "2026-01-23T12:01:00+09:00",
  "confidence": 0.9,
  "is_simulated": true
}
```

## 除雪車

除雪車は`geometry.type=Point`、座標順はGeoJSON規約どおり`[longitude, latitude]`で返す。`matched_segment_id`で道路Featureの`properties.segment_id`と関連付ける。`observed_at`は固定デモシナリオ内の時刻、`data_timestamp`はDBが保持する実受信時刻`received_at`であり、クライアントは位置更新の新旧判定に`data_timestamp`を使う。

フロントエンドは道路の最初のページと除雪車を並列取得する。最初の道路ページを受信した時点で地図を表示し、地図移動時に新しい表示範囲の道路へ差し替える。除雪車だけを約5秒間隔でポーリングする。

道路検索は`road_segments`が保持する外接矩形列とリクエスト`bbox`をPostgreSQL上で比較し、SQLの`LIMIT + 1`まで取得する。Lambdaで全道路を読み込んでから絞り込まない。返却件数を超える道路がある場合は`truncated=true`とする。

## エラー

入力不正は400、対象なしは404、DB停止・一時障害は503とし、`error.code`と安全な`error.message`を返す。DB接続情報や内部例外は返さない。
