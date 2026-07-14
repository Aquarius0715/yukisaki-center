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

AWSでは`WeatherWindowCollector` Lambdaを手動実行する。EventBridge Schedulerは固定デモ日には不要なため構築しない。

## 道路収集

`src/data_ingestion/road/`がOpenStreetMap道路ネットワークを取得し、約25mの道路区間へ分割して次へ保存する。AWSではDockerfileの`road-runtime`ターゲットをECS Fargateタスクとして実行し、EventBridge Ruleで定期起動する。

```text
raw/osm/road-network/{run_id}/...
manifests/data-ingestion/{run_id}.json
```

FargateコンテナにはAWSアクセスキーを渡さず、Task IAM Roleで上記プレフィックスへの書き込みだけを許可する。

## サブパッケージ

| サブパッケージ | データ源 | 実行方式 | 状態 |
|---|---|---|---|
| `weather/` | Open-Meteo | Lambda（手動実行） | 実装済み |
| `road/` | OpenStreetMap | ECS Fargate（定期バッチ） | 実装済み |
| `snow_pipe/` | 消雪パイプfixture | 未定 | スケルトン |
| `plow_gps/` | 除雪車GPS fixture | 未定 | スケルトン |

## 構成

- `src/data_ingestion/weather/`: Open-Meteo気象ウィンドウ収集Lambda
- `src/data_ingestion/road/`: 道路ネットワーク収集、約25m分割、S3 raw保存（ECS Fargateバッチ）
- `src/data_ingestion/snow_pipe/`: 消雪パイプ仮データ投入（未実装のスケルトン）
- `src/data_ingestion/plow_gps/`: 除雪車GPS仮データ投入（未実装のスケルトン）
- `tests/`: サブパッケージに対応した単体テスト（例: `tests/weather/`）
- `config/`: 環境変数の説明
- `docs/`: S3入出力契約
- `AGENTS.md`: このサービスを扱うAI向け指示

Docker単体テストは`infrastructure/cdk`で`npm run test:services`を実行する。道路収集コンテナはDockerfileの`road-runtime`ターゲットであり、独立した`YukisakiRoadCollector-*` Fargateスタックが道路専用S3バケットの`raw/osm/road-network/`とmanifestだけへの書込み権限を持つ。
