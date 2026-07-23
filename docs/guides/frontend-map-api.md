# フロントエンドから地図・除雪車APIを使う

## 起動とURL確認

`infrastructure/cdk/`で実行する。

```bash
npm run env:start -- --profile yukisaki-dev
npm run env:status -- --profile yukisaki-dev
```

ローカルWebでは`mapApi=... url=https://...`に表示されたURLを`VITE_YUKISAKI_API_URL`へ設定する。AWSのCloudFront Webは`web=... url=https://...`のURLを開く。CloudFrontが`/v1/*`と`/healthz`をAPI Gatewayへ同一オリジン転送するため、AWSビルドではAPIベースURLを設定しない。API Lambdaと共通RDSは`env:stop`中は停止しているため、その状態のAPI呼び出しは利用できない。

## 動作確認

```bash
export YUKISAKI_API_URL="https://表示されたURL"

curl "${YUKISAKI_API_URL}/healthz"
curl "${YUKISAKI_API_URL}/v1/road-segments?bbox=138.84375,37.413334,138.92375,37.473334&limit=75"
curl "${YUKISAKI_API_URL}/v1/snowplows"
curl "${YUKISAKI_API_URL}/v1/map/snapshot?bbox=138.643056,37.176389,139.124444,37.710278"
```

## ブラウザ側の取得例

```javascript
const API_URL = import.meta.env.VITE_YUKISAKI_API_URL;

export async function fetchRoadPage(mapBounds, cursor) {
  const bbox = [
    mapBounds.getWest(),
    mapBounds.getSouth(),
    mapBounds.getEast(),
    mapBounds.getNorth(),
  ].join(",");
  const query = new URLSearchParams({ bbox, limit: "75" });
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`${API_URL}/v1/road-segments?${query}`);
  if (!response.ok) throw new Error(`road API failed: ${response.status}`);
  return response.json();
}

export async function fetchSnowplows() {
  const response = await fetch(`${API_URL}/v1/snowplows`);
  if (!response.ok) throw new Error(`snowplow API failed: ${response.status}`);
  return response.json();
}
```

道路Featureは`segment_id`をキーに保持し、除雪車Featureの`matched_segment_id`で現在走行中の道路と紐付ける。道路と除雪車は並列取得し、道路は表示範囲ごとに75件取得する。MapKitへは現在の1ページだけを描画し、`next_cursor`のページをブラウザへ自動蓄積しない。Apple MapKit JSの`region-change-end`後に現在の表示範囲を`bbox`として再取得して道路を差し替え、連続操作は400ミリ秒でデバウンスする。次の表示範囲へ移動した場合は古い通信をAbortControllerで中断し、古い応答を反映しない。除雪車位置は約5秒間隔で取得し、MapKit座標更新は最大毎秒5回、移動補間が完了した時点で停止する。`is_simulated: true`は画面に「デモデータ」と表示する。

## 停止

```bash
npm run env:stop -- --profile yukisaki-dev
```

API Gatewayはリクエスト課金のため残るが、API Lambdaの予約同時実行数は0になり、RDSも停止する。
Web配信S3は保持され、CloudFront Distributionは無効化される。反映状況は`npm run web:status -- --profile yukisaki-dev`で確認する。
