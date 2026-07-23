# Apple Maps地点検索API

## 概要

経路探索の始点・終点を名称から座標へ変換するバックエンドAPIである。WebからAppleへ直接検索せず、API Gateway配下の専用LambdaがApple Maps Server APIを呼び出す。

- 対象地域: 新潟県長岡市
- 言語: `ja-JP`
- 国: `JP`
- プロバイダー: Apple Maps Server API
- 仮データ: `is_simulated: false`
- Web実装: 本機能の対象外

既存Map API LambdaはRDS用のisolated subnetに維持する。地点検索LambdaだけをVPC外に配置するため、Apple MapsへのHTTPS通信にNAT Gatewayは不要である。地点検索LambdaはDBへ接続できない。

## エンドポイント

### 名称検索

```bash
API_URL="https://APIのURL"

curl -sS --get "${API_URL}/v1/places/search" \
  --data-urlencode 'q=長岡駅' | jq
```

`q`は前後の空白を除いて2〜100文字とする。Appleへは長岡市bboxと`searchRegionPriority=required`を渡す。Appleでは`searchRegion`と`searchLocation`を同時指定できないため、範囲制約を優先して中心座標は送らない。さらに、返却座標がbbox外の候補はバックエンドで除外する。

```json
{
  "query": "長岡駅",
  "results": [
    {
      "place_id": "8b0a2d2efbba8e8988e3566e",
      "name": "長岡駅",
      "address": "新潟県長岡市城内町",
      "latitude": 37.4477,
      "longitude": 138.853,
      "country_code": "JP",
      "provider": "apple_maps",
      "confidence": null,
      "is_simulated": false
    }
  ],
  "count": 1,
  "search_region": {
    "name": "新潟県長岡市",
    "bbox": [138.643056, 37.176389, 139.124444, 37.710278]
  },
  "provider": "apple_maps",
  "data_timestamp": "2026-07-24T00:00:00+00:00",
  "confidence": null,
  "is_simulated": false
}
```

Appleは検索結果の信頼度を返さないため、`confidence`を推測せず`null`とする。`place_id`は名称と座標から生成するYukisaki内の安定キーであり、AppleのPlace IDではない。

### 入力補完

```bash
curl -sS --get "${API_URL}/v1/places/autocomplete" \
  --data-urlencode 'q=長岡' | jq
```

応答の`results[].query`を名称検索の`q`へ渡す。Appleの`completionUrl`に含まれるopaque metadataは公開APIから返さない。

## Apple認証情報

ブラウザ用`VITE_MAPKIT_TOKEN`は使用しない。Apple DeveloperでMaps IDと秘密鍵を用意し、Maps Server API専用の`server_api`トークンをLambda内で動的に生成する。

Secrets Managerへ次のJSONを登録する。

- Secret名: `yukisaki/dev/api/apple-maps-server-api`
- `team_id`: Apple Developer Team ID
- `key_id`: Maps秘密鍵のKey ID
- `private_key`: ダウンロードした`.p8`のPEM全文

```json
{
  "team_id": "TEAM_ID",
  "key_id": "KEY_ID",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
}
```

秘密鍵、SecretString、生成JWTをGit、`env.local`、ログへ書かない。秘密鍵はAppleから再ダウンロードできないため、安全な場所にも保管する。

Lambdaは有効期間15分、`scope=server_api`のES256認証JWTを作り、Appleの`GET /v1/token`でMaps access tokenへ交換する。検索APIにはaccess tokenを渡し、Appleが返す有効期間の間はウォーム実行内で再利用する。Secrets ManagerにはJWTやaccess tokenではなく秘密鍵を保存する。

## デプロイと起動

認証情報を登録後、`infrastructure/cdk/`で検証・デプロイする。

```bash
npm test
npm run build
npm run synth
npm run deploy -- YukisakiApi-dev --require-approval never --profile yukisaki-dev
npm run env:start -- --profile yukisaki-dev
npm run env:status -- --profile yukisaki-dev
```

`env:status`の`placeSearch`が`enabled`なら呼び出せる。デプロイ直後は予約同時実行数0で停止している。`env:stop`では既存サービスと一緒に停止する。

## エラー

| HTTP | `error.code` | 意味 |
|---|---|---|
| 400 | `invalid_request` | `q`が不正 |
| 429 | `apple_maps_rate_limited` | Appleの日次クォータ超過 |
| 502 | `apple_maps_upstream_error` | Apple APIのエラー・タイムアウト |
| 503 | `apple_maps_not_configured` | Secret未設定 |
| 503 | `apple_maps_credentials_invalid` | Secret形式または認証情報が不正 |

内部例外、秘密鍵、JWT、Secret ARN、Appleの詳細エラー本文は公開レスポンスへ含めない。
