# Bedrock AIアシスタント

## 現在の状態

2026-07-22にサービス実装、DockerイメージLambda、APIルート、IAMをAWSへデプロイ済みである。API Gatewayと定型文フォールバックは実環境で動作確認済みである。

2026-07-26にAnthropic use case details formの提出とAWS Marketplace初回購読を完了した。Claude Sonnet 4.5の直接呼び出しと、公開`POST /v1/ai/parse-route-request`、`POST /v1/ai/explain-routes`で`fallback_used: false`の実推論を確認済みである。詳細な自然文説明もAWSへデプロイ済みで、入力にない道路状態や主観的な安全評価を含む出力は破棄して定型文へフォールバックする。Bedrockの一時障害や出力検証失敗時も、`fallback_used: true`の定型応答を返す。

## 事前確認

1. AWS Consoleで東京リージョンを選ぶ。
2. Amazon BedrockのModel accessで、設定したモデルを利用できることを確認する。
3. 別のAWSアカウントでClaudeを初めて使う場合は、Anthropic use case details formを実際の組織・用途情報で提出し、Marketplace初回購読を完了する。
4. 必要ならCDKコンテキスト`bedrockModelId`をStructured Outputs対応モデルへ変更する。
5. Guardrailを利用する場合だけ`bedrockGuardrailIdentifier`と`bedrockGuardrailVersion`を同時に指定する。

## ローカル検証

Bedrockへ接続せず、モックで安全境界とフォールバックを検証する。

```bash
cd infrastructure/cdk
docker compose -f ../compose/docker-compose.yml run --build --rm ai-assistant-test
npm run test:infra
npm run build
npm run synth
```

## デプロイ

AWS変更の依頼と承認後に、依存元のAPIスタックとAIスタックをデプロイする。

```bash
cd infrastructure/cdk
npx cdk deploy YukisakiApi-dev YukisakiAiAssistant-dev --profile yukisaki-dev
```

初回は停止状態なので、全実行系と一緒に起動する。

```bash
npm run env:start -- --profile yukisaki-dev
npm run env:status -- --profile yukisaki-dev
```

利用後は停止する。

```bash
npm run env:stop -- --profile yukisaki-dev
```

## 疎通確認

`ApiUrl`は`env:status`またはCloudFormation出力で確認する。

```bash
curl -X POST "${API_URL}/v1/ai/parse-route-request" \
  -H 'content-type: application/json' \
  -d '{"text":"長岡駅から石動南町まで、坂道を避けて安全な道で行きたい"}'
```

出力地点はまだ確定していない。フロントエンドで位置検索候補を提示し、利用者が確認してから経路探索へ渡す。
