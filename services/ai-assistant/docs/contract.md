# 入出力契約

全エンドポイントは`POST`、`Content-Type: application/json`を使用する。成功時は`result`と`metadata`を返す。

```json
{
  "result": {},
  "metadata": {
    "model_id": "jp.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "fallback_used": false,
    "is_simulated": true,
    "data_timestamp": "2026-01-23T12:00:00+09:00"
  }
}
```

## `POST /v1/ai/parse-route-request`

入力は1,000文字以下の`text`。出力は出発地・目的地・経由地の検索文字列、優先方針、回避・優先条件、運転経験、不足項目、確認要否である。緯度経度は出力しない。地点は別の位置検索サービスで解決し、利用者の確認後に確定する。

## `POST /v1/ai/explain-routes`

入力は`POST /v1/routes`の成功レスポンスをそのまま使用できる。互換性のため、従来どおり`recommended_route_id`を明示した1〜3件の経路根拠も受け付ける。

`recommended_route_id`省略時は、経路探索が返した最小`rank`の経路を推奨として固定する。Bedrockへ渡す前にGeometry、`segment_ids`、危険区間Geometryを除去し、次の根拠だけに正規化する。

- 順位、ラベル、距離、所要時間
- 平均・最低走りやすさ指数、指数カバレッジ、最低信頼度
- 除雪率、消雪パイプ率
- 危険区間数と危険要因
- データ時刻、デモ基準時刻、`is_simulated`

LLM出力の推奨IDと全経路IDが入力と完全一致しなければ破棄し、定型文へフォールバックする。順位・数値の再計算は行わない。入力に交通・天気の明示的な根拠がないため、現在は渋滞、事故、規制、天気予報を説明しない。

## `POST /v1/ai/explain-danger-points`

入力は1〜20件の`hazards`、`data_timestamp`、`is_simulated`。各要素は一意の`hazard_id`、適用ルール、説明根拠を持つ。LLM出力のIDと順序が入力と完全一致しなければ定型文へフォールバックする。

## エラー

- `400`: JSON不正、必須値不足、件数・文字数・リクエストサイズ超過
- `404`: 未定義パス

Bedrockの一時障害やGuardrail介入はサービス停止にせず、`200`と`fallback_used: true`を返す。プロンプトや利用者入力本文はCloudWatch Logsへ記録しない。
