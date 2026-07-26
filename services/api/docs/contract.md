# 地図・除雪車API契約

全エンドポイントはHTTPSのAPI Gateway HTTP APIから公開する。`data_timestamp`、`confidence`、`is_simulated`を応答に含め、デモ用GPS・消雪パイプ・指数を実データとして扱わない。

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/healthz` | Lambdaの稼働確認 |
| GET | `/v1/road-segments` | 表示範囲の道路を通常または地図用軽量GeoJSONで取得 |
| GET | `/v1/road-segments/{id}` | 道路区間1件を取得 |
| GET | `/v1/snowplows` | 除雪車の最新位置をPoint GeoJSONで取得 |
| GET | `/v1/map/snapshot` | 初期表示用に道路と除雪車を一括取得 |
| GET | `/v1/places/search` | Apple Mapsで長岡市内の名称を座標へ変換 |
| GET | `/v1/places/autocomplete` | Apple Mapsで長岡市内の検索候補を取得 |
| POST | `/v1/routes` | 始点・終点と選好から最大3件の経路候補を取得 |

`POST /v1/routes`の詳細な入出力、固定デモ日時、エラー契約は[経路探索サービスAPI契約](../../route-planning/docs/contract.md)を正本とする。
地点検索の認証・入出力・運用は[Apple Maps地点検索API](../../../docs/guides/place-search-api.md)を参照する。

## 道路のクエリ

- `bbox=west,south,east,north`: 地図の表示範囲。省略時は長岡市全域`138.643056,37.176389,139.124444,37.710278`
- `limit=1..5000`: 1ページの最大道路件数。省略時は5,000件。Webの近距離タイルは1,500件を使用する
- `cursor`: 前ページの`next_cursor`。同じ`bbox`の続きを取得する場合だけ指定する
- `view=detail|map`: 省略時は後方互換の`detail`。Web地図は`map`を指定する
- `min_road_rank=0..6`: 道路種別の最低ランク。省略時は0で全道路を対象とする。広域Web地図は縮尺に応じた値を指定し、道路種別を絞ってからページングする

道路ランクは`0=その他を含む全道路`、`1=residential/unclassified以上`、`2=tertiary以上`、`3=secondary以上`、`4=primary以上`、`5=trunk以上`、`6=motorway`とする。`*_link`は接続先道路と同じランクとして扱う。

レスポンスに続きがある場合は`truncated: true`と`next_cursor`が返る。Web地図は固定空間タイルごとに先頭ページを先に描画し、後続ページを間隔を空けて段階的に補完する。

`view=map`は地図描画に必要な`segment_id`、Geometry、`road_name`、`road_type`、`drivability_score`、`snow_pipe`、`snow_pipe_operation_status`だけをFeatureへ含める。信頼度、データ時刻、仮データ区分はコレクションのメタデータに保持する。指数根拠、勾配、延長、消雪効果、最終除雪情報は返さず、道路選択時に`GET /v1/road-segments/{id}`から取得する。省略時の`view=detail`は従来契約を維持する。

道路一覧、道路詳細、snapshotの成功レスポンスは`Cache-Control: public,max-age=30,s-maxage=90`を基本とし、CloudFrontで表示タイル単位に共有する。地図一覧とsnapshotは`stale-while-revalidate=120`も許可する。除雪車位置、エラー応答、その他の動的応答は`no-store`を維持する。

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

道路検索は`road_segments`が保持する外接矩形列とリクエスト`bbox`をPostgreSQL上で比較し、`min_road_rank`の道路種別条件を適用してからSQLの`LIMIT + 1`まで取得する。LambdaやWebで全道路を読み込んでからページ対象を絞り込まない。返却件数を超える道路がある場合は`truncated=true`とする。

## エラー

入力不正は400、対象なしは404、Apple上流障害は502、DB停止・設定不備・一時障害は503とし、`error.code`と安全な`error.message`を返す。DB接続情報、Apple JWT、秘密鍵、内部例外は返さない。
