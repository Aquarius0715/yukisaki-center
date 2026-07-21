# Yukisaki Web API契約

WebはREST APIだけを利用し、S3やPostgreSQLへ直接接続しない。日時はISO 8601、座標はWGS84（経度・緯度）とする。実装型の正本は `src/api/contracts.ts`。

## エンドポイント

| Method | Path | 概要 |
|---|---|---|
| GET | `/health` | 稼働確認 |
| GET | `/road-segments?bbox=minLon,minLat,maxLon,maxLat` | GeoJSON道路区間 |
| POST | `/road-conditions/query` | `{ "segmentIds": ["id"] }` に対応する計算済み道路状態 |
| GET | `/snowmelt-pipes?bbox=...` | 消雪パイプ状態 |
| GET | `/snowplows?bbox=...` | 除雪車・軌跡 |
| GET | `/weather?lat=...&lon=...` | 参考天気 |
| GET | `/destinations?q=...` | 目的地候補 |
| POST | `/routes/recommend` | 3種類の計算済み経路候補 |

道路状態は `segmentId`, `hasSnowmeltPipe`, `snowmeltPipeOperating`, `lastPlowedAt`, `plowVehicleId`, `roadWidthM`, `slopePercent`, `drivabilityScore`, `status`, `scoreBreakdown`, `reasons`, `warnings`, `updatedAt`, `isSimulated` を返す。指数や危険理由はサーバー側で決定し、Webは再計算しない。

経路リクエストは次の形式。

```json
{
  "origin": { "latitude": 37.442762, "longitude": 138.790865 },
  "destination": { "latitude": 37.4454, "longitude": 138.795 },
  "preference": "recommended"
}
```

レスポンスは `routes`, `generatedAt`, `isSimulated` を含む。各routeは `id`, `label`, `durationMinutes`, `distanceKm`, `drivabilityScore`, `plowedRatio`, `snowmeltPipeRatio`, `noPlowRecordSegmentCount`, `hasNarrowRoad`, `hasSteepSlope`, GeoJSON `geometry`, `warnings`, `reasons` を持つ。

## エラー

非2xxでは次を返す。内部例外・認証情報はメッセージへ含めない。

```json
{ "error": { "code": "ROAD_DATA_UNAVAILABLE", "message": "道路データを取得できませんでした", "requestId": "..." } }
```

API Gatewayでは配信元CloudFrontドメインだけを `Access-Control-Allow-Origin` に許可し、必要なmethod/headerへ限定する。
