# データ収集サービス

外部データと仮データを取得し、原本と取得メタデータをS3 `raw/`へ不変保存する唯一の入口である。PostgreSQLへ直接書き込まない。

データ源ごとに`src/data_ingestion/`配下をサブパッケージへ分離する。すべて同じ`raw/{source}/{dataset}/...`契約に従う。

| サブパッケージ | データ源 | 状態 |
|---|---|---|
| `weather/` | 気象庁Atomフィード | 実装済み（Lambdaハンドラ） |
| `road/` | OpenStreetMap道路ネットワーク | 実装済み（ECS Fargateバッチ） |
| `snow_pipe/` | 消雪パイプ仮データ（fixture、`is_simulated: true`） | 未実装 |
| `plow_gps/` | 除雪車GPS仮データ（fixture、`is_simulated: true`） | 未実装 |

```text
外部データ / fixture
  -> data-ingestion（weather / road / snow_pipe / plow_gps）
  -> S3 raw/
```

## 構成

- `src/data_ingestion/weather/`: 気象庁Atomフィード収集Lambdaハンドラ
- `src/data_ingestion/road/`: 道路ネットワーク収集、約25m分割、S3 raw保存（ECS Fargateバッチ）
- `src/data_ingestion/snow_pipe/`: 消雪パイプ仮データ投入（未実装のスケルトン）
- `src/data_ingestion/plow_gps/`: 除雪車GPS仮データ投入（未実装のスケルトン）
- `tests/`: サブパッケージに対応した単体テスト（例: `tests/weather/`）
- `config/`: 環境変数の説明
- `docs/`: S3入出力契約
- `AGENTS.md`: このサービスを扱うAI向け指示

Docker単体テストは`infrastructure/cdk`で`npm run test:services`を実行する。道路収集コンテナはDockerfileの`road-runtime`ターゲットであり、Fargateタスクにはアクセスキーを渡さず、Task IAM RoleでS3の`raw/osm/road-network/`とmanifestだけへ書き込む。
