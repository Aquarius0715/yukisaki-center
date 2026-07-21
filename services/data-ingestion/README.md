# データ収集サービス

外部データを取得し、原本・取得メタデータ・manifestをS3 `raw/`へ不変保存する。PostgreSQLへは直接接続しない。

## 気象収集

`src/data_ingestion/weather/window_collector.py`が次の実データを取得する。

- 対象: 2026年1月23日12:00 JST、長岡市石動南町（37.442762, 138.790865）
- 過去気象: Open-Meteo Historical Weather APIの09:00〜12:00
- 当時予報: Open-Meteo Historical Forecast APIの13:00〜15:00
- 項目: 気温、湿度、降水量、降雪量、積雪深、WMO天気コード、風速、突風

2つのAPI応答はまとめて次へ保存する。

```text
raw/open-meteo/weather-window/event_date=2026-01-23/run_id={run_id}/response.json
raw/open-meteo/weather-window/event_date=2026-01-23/run_id={run_id}/metadata.json
manifests/data-ingestion/{run_id}.json
```

AWSでは`WeatherWindowCollector` LambdaをEventBridge Ruleから起動する。Ruleはデプロイ時に必ず無効で、開発・デモ時に`npm run env:start`で有効化する。手動Lambda実行も可能である。

## 道路収集

`src/data_ingestion/road/`がOpenStreetMap道路ネットワークを取得し、約25mの道路区間へ分割して次へ保存する。AWSではDockerfileの`road-runtime`ターゲットをECS Fargateタスクとして実行する。EventBridge RuleはWeatherと同様にデプロイ時は無効である。

```text
raw/osm/road-network/ingest_date={date}/run_id={run_id}/...
manifests/data-ingestion/{run_id}.json
```

FargateコンテナにはAWSアクセスキーを渡さず、Task IAM Roleで上記プレフィックスへの書き込みだけを許可する。

## サブパッケージ

| サブパッケージ | データ源 | 実行方式 | 状態 |
|---|---|---|---|
| `weather/` | Open-Meteo | EventBridge → Lambda | 実装済み（既定停止） |
| `road/` | OpenStreetMap | EventBridge → ECS Fargate | 実装済み（既定停止） |
| `snow_pipe/` | 道路名ルールによる消雪パイプ仮データ | S3 manifest → EventBridge → Step Functions → Lambda | 実装済み |
| `plow_gps/` | GPS Simulatorの仮データ | EventBridge → SQS → Lambda | 実装済み（S3 raw保存） |

## 共通収集契約

Weatherと道路は`src/data_ingestion/common/metadata.py`を使用し、S3 rawに付随する`metadata.json`とmanifestへ次を同じフィールド名で保存する。

- `run_id`
- `fetched_at`
- `target_start_at` / `target_end_at`
- `source` / `source_urls`
- `checksum_sha256`
- `dataset` / `metadata_schema_version` / `is_simulated`

収集コンテナはPostgreSQLへ接続しない。DBロードは必ずS3 rawを入力とする`data-processing`が担当する。詳細は`docs/contract.md`を参照する。

## 構成

- `src/data_ingestion/weather/`: Open-Meteo気象ウィンドウ収集Lambda
- `src/data_ingestion/road/`: 道路ネットワーク収集、約25m分割、S3 raw保存（ECS Fargateバッチ）
- `src/data_ingestion/common/`: 全Collector共通のメタデータ契約
- `src/data_ingestion/snow_pipe/`: 道路完了manifestを検証し、道路名がある区間の消雪パイプ仮データをS3 rawへ保存
- `src/data_ingestion/plow_gps/`: SQS配信GPSイベント検証、S3 raw JSON Lines・manifest保存
- `tests/`: サブパッケージに対応した単体テスト（例: `tests/weather/`）
- `config/`: 環境変数の説明
- `docs/`: S3入出力契約
- `AGENTS.md`: このサービスを扱うAI向け指示

Docker単体テストは`infrastructure/cdk`で`npm run test:services`を実行する。Weatherも道路もDockerイメージで実行する。道路収集コンテナはDockerfileの`road-runtime`ターゲットであり、独立した`YukisakiRoadCollector-*` Fargateスタックが道路専用S3バケットの`raw/osm/road-network/`とmanifestだけへの書込み権限を持つ。
