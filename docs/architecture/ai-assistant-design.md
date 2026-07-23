# Bedrock AIアシスタント設計

## 目的と境界

利用者の自然言語を機械処理可能な条件へ変換し、別サービスが確定した経路・危険根拠を読みやすく説明する。LLMは走りやすさ指数、危険度、候補順位、通行可否を決定しない。

経路探索は現在保留中であるため、経路比較と危険説明はfixtureまたは将来の経路探索APIが返す確定済みデータを入力とする。AIサービス自身はPostgreSQLやS3を参照しない。

## AWS構成

```text
Web / caller
    |
    | POST /v1/ai/*
    v
API Gateway HTTP API
    |
    v
AI Assistant Docker Lambda  -- Converse API --> Amazon Bedrock
    |                              |
    |                              +-- Structured Outputs (JSON Schema)
    |                              +-- Guardrail（任意）
    +-- CloudWatch Logs（本文・プロンプトは記録しない）
```

AI LambdaはRDSを必要としないためVPCへ入れない。DB接続用NATやSecurity Groupを増やさず、Bedrock呼出し権限だけを持つ。既存のAPI Gateway HTTP APIへ3本のPOSTルートを追加する。

## モデルとリージョン

既定値は`jp.anthropic.claude-sonnet-4-5-20250929-v1:0`で、CDKコンテキストから変更可能とする。Japan Geo Inference Profileを使い、Structured Outputs対応モデルを前提にする。利用前に対象AWSアカウントのBedrock Model accessを確認し、ClaudeについてはAnthropic use case details formを実際の組織・用途情報で提出する。

## 安全設計

1. 用途ごとにプロンプトとJSON Schemaを分離する。
2. 自然言語抽出では緯度経度をSchemaに含めず、地点名を未確認の検索文字列として返す。
3. 経路・危険説明では、入力と出力の識別子および順序を照合する。
4. 識別子変更、Bedrock障害、Guardrail介入、JSON不正時は決定論的な定型文へ切り替える。
5. 仮データは`is_simulated: true`を応答へ引き継ぐ。
6. CloudWatch Logsにはアクション名だけを記録し、利用者本文やプロンプトを出力しない。

Structured OutputsのSchemaはBedrockが対応するJSON Schema Draft 2020-12のサブセットに限定する。初回のSchemaコンパイルは通常より時間がかかる可能性があるため、Lambdaタイムアウトを40秒とする。

## ライフサイクルとコスト

Lambdaはデプロイ時に予約済み同時実行数`0`で停止する。デプロイ後は既存の`env:start|stop|status`へ統合され、開発・デモ時だけ呼出せる。Bedrockは呼出し量に応じた課金であり、停止中のAI Lambdaからは呼び出されない。

## 参考

- [Amazon Bedrock Structured Outputs](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html)
- [Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
- [Converse APIでGuardrailを使用する](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-converse-api.html)
- [Claude Sonnet 4.5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-5.html)
