# 自然言語・説明サービス

Amazon Bedrockを使い、次の3機能を提供するDocker Lambdaサービスである。

- 自然言語から地点検索文字列と経路希望を抽出する
- 経路探索が確定した最大3候補を比較説明する
- ルール処理が確定した危険箇所を説明する

走りやすさ指数、候補順位、通行可否、危険度はLLMに決定させない。経路説明APIは従来の`POST /v1/routes`レスポンスを直接受け取り、1位の経路IDを固定したうえで、Geometryと区間IDを除外してBedrockへ渡す。経路説明と危険説明は、呼出元が渡した`data_timestamp`と`is_simulated`を応答にも保持する。Bedrockの失敗、Guardrail介入、不正な識別子変更があった場合は、入力事実だけを使う定型文へフォールバックする。

## ディレクトリ

```text
src/ai_assistant/
  bedrock.py      Bedrock Converse APIとStructured Outputs
  handler.py      API Gateway HTTP APIハンドラ
  prompts.py      責務別システムプロンプト
  schemas.py      構造化出力JSON Schema
  service.py      入力検証、安全境界、フォールバック
tests/            Bedrockをモックした単体テスト
config/           非秘密設定の説明
docs/             API入出力契約
```

## ローカルテスト

```bash
docker compose -f infrastructure/compose/docker-compose.yml run --build --rm ai-assistant-test
```

AWS構成と利用方法は[Bedrock AIアシスタント](../../docs/guides/bedrock-ai-assistant.md)、詳細な入出力は[契約](docs/contract.md)を参照する。
