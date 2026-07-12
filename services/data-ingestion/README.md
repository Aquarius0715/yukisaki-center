# データ収集サービス

外部データと仮データを取得し、原本と取得メタデータをS3 `raw/`へ不変保存する唯一の入口である。PostgreSQLへ直接書き込まない。

現在は気象庁Atomフィードを収集するLambdaコンテナを実装している。道路、標高、GPSも追加時は同じ`raw/{source}/{dataset}/...`契約に従う。

```text
外部データ / fixture
  -> data-ingestion
  -> S3 raw/
```

## 構成

- `src/data_ingestion/`: Lambdaハンドラ
- `tests/`: 収集・URL検証の単体テスト
- `config/`: 環境変数の説明
- `docs/`: S3入出力契約
- `AGENTS.md`: このサービスを扱うAI向け指示

Docker単体テストは`infrastructure/cdk`で`npm run test:services`を実行する。
