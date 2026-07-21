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

- `bbox=west,south,east,north`: 地図の表示範囲。省略時は石動南町周辺`138.74,37.40,138.84,37.49`
- `limit=1..5000`: 最大道路件数。省略時は5,000件

レスポンスが上限を超えると`truncated: true`になる。フロントエンドは表示範囲を狭めて再取得する。

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
  "bbox": [138.74, 37.40, 138.84, 37.49],
  "count": 1,
  "truncated": false,
  "data_timestamp": "2026-01-23T12:01:00+09:00",
  "confidence": 0.9,
  "is_simulated": true
}
```

## 除雪車

除雪車は`geometry.type=Point`、座標順はGeoJSON規約どおり`[longitude, latitude]`で返す。`matched_segment_id`で道路Featureの`properties.segment_id`と関連付ける。

フロントエンドは初回だけ`/v1/map/snapshot`を取得するか、道路と除雪車を個別取得する。その後は地図移動時に道路を再取得し、除雪車だけを約5秒間隔でポーリングする。

## エラー

入力不正は400、対象なしは404、DB停止・一時障害は503とし、`error.code`と安全な`error.message`を返す。DB接続情報や内部例外は返さない。
