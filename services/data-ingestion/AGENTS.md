# AI作業指示

このサービスは外部データをS3 `raw/`へ不変保存する入口であり、PostgreSQLへ直接書かない。気象は`weather/window_collector.py`だけをAWS Lambdaとして使用する。

基準時刻は2026-01-23 12:00 JST、地点は長岡市石動南町。Open-Meteoの過去観測を`-3..0`、過去予報を`+1..3`として取得する。APIの系列値を収集段階で混合・補間しない。

全Collectorは`common/metadata.py`を使い、`run_id`、`fetched_at`、`target_start_at`、`target_end_at`、`source`、`source_urls`、`checksum_sha256`、`is_simulated`を同じ名前でmetadataとmanifestへ保持する。EventBridge Ruleはデプロイ時に無効とし、開発・デモ時だけ運用コマンドで有効化する。

`src/data_ingestion/`はデータ源ごとに`weather/`（Open-Meteo、Lambdaとして実装済み）、`road/`（OpenStreetMap道路ネットワーク、ECS Fargateバッチとして実装済み）、`snow_pipe/`（消雪パイプ仮データ、未実装）、`plow_gps/`（除雪車GPS仮データ、未実装）へ分離する。新しい収集元は既存サブパッケージへ混在させない。

道路タスクはTask IAM Roleを使い、アクセスキーやAWS CLIプロファイルをコンテナへ渡さない。`snow_pipe/`と`plow_gps/`は本MVPでは常にfixtureからの仮データであり、出力に`is_simulated: true`を保持する。
