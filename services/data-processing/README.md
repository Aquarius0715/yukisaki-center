# データ処理・PostgreSQLロードサービス

S3 `raw/`を検証・正規化し、再生成可能な`normalized/`と`curated/`へ出力する。検証済みの`curated/`だけをPostgreSQLの配信用テーブルへロードする。S3が正本であり、PostgreSQLはS3から再作成できる派生ストアである。

現在の`src/data_processing/handler.py`は気象庁AtomフィードをS3 `normalized/`へ変換するLambdaハンドラである。`src/data_processing/load_curated.py`はJSON LinesをPostgreSQLへUPSERTするコンテナ実行用ローダーであり、RDS/ECS実装時に利用する。

```text
S3 raw/
  -> handler.py
  -> S3 normalized/ -> S3 curated/
  -> load_curated.py
  -> PostgreSQL serving tables
```

ローカルDBの初期スキーマは`infrastructure/postgres/init/001_schema.sql`に置く。`docker compose -f infrastructure/compose/docker-compose.yml up postgres`で起動できる。

ローダーイメージは`Dockerfile`の`loader`ターゲットである。`DATABASE_URL`とS3認証情報を与え、`s3://.../part-00000.jsonl`を引数にしてECS Fargate等から実行する。

## 構成

- `src/data_processing/`: LambdaハンドラとDBローダー
- `tests/`: 正規化・URI検証の単体テスト
- `config/`: ローダー依存関係
- `docs/`: S3・DBロード契約
- `AGENTS.md`: このサービスを扱うAI向け指示
