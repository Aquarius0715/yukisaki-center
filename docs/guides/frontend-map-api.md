# フロントエンドから地図・除雪車APIを使う

## 起動とURL確認

`infrastructure/cdk/`で実行する。

```bash
npm run env:start -- --profile yukisaki-dev
npm run env:status -- --profile yukisaki-dev
```

`mapApi=... url=https://...`に表示されたURLをフロントエンドのAPIベースURLへ設定する。API Lambdaと共通RDSは`env:stop`中は停止しているため、その状態のAPI呼び出しは利用できない。

## 動作確認

```bash
export YUKISAKI_API_URL="https://表示されたURL"

curl "${YUKISAKI_API_URL}/healthz"
curl "${YUKISAKI_API_URL}/v1/road-segments?bbox=138.74,37.40,138.84,37.49&limit=5000"
curl "${YUKISAKI_API_URL}/v1/snowplows"
curl "${YUKISAKI_API_URL}/v1/map/snapshot?bbox=138.74,37.40,138.84,37.49"
```

## ブラウザ側の取得例

```javascript
const API_URL = import.meta.env.VITE_YUKISAKI_API_URL;

export async function fetchRoads(mapBounds) {
  const bbox = [
    mapBounds.getWest(),
    mapBounds.getSouth(),
    mapBounds.getEast(),
    mapBounds.getNorth(),
  ].join(",");
  const response = await fetch(`${API_URL}/v1/road-segments?bbox=${bbox}`);
  if (!response.ok) throw new Error(`road API failed: ${response.status}`);
  return response.json();
}

export async function fetchSnowplows() {
  const response = await fetch(`${API_URL}/v1/snowplows`);
  if (!response.ok) throw new Error(`snowplow API failed: ${response.status}`);
  return response.json();
}
```

道路Featureは`segment_id`をキーに保持し、除雪車Featureの`matched_segment_id`で現在走行中の道路と紐付ける。道路形状は地図の初期表示・移動時に取得し、除雪車位置だけを約5秒間隔で更新する。`is_simulated: true`は画面に「デモデータ」と表示する。

## 停止

```bash
npm run env:stop -- --profile yukisaki-dev
```

API Gatewayはリクエスト課金のため残るが、API Lambdaの予約同時実行数は0になり、RDSも停止する。
