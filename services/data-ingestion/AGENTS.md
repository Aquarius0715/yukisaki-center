# AI作業指示

このサービスは外部データをS3 `raw/`へ不変保存する入口である。PostgreSQLへ書き込まない。取得元、取得時刻、チェックサム、`run_id`、`is_simulated`を保持し、公開データの利用条件を確認せずに収集先を追加しない。

`src/data_ingestion/`はデータ源ごとに`weather/`（気象庁Atomフィード、実装済み）、`road/`（OpenStreetMap道路ネットワーク、ECS Fargateバッチとして実装済み）、`snow_pipe/`（消雪パイプ仮データ、未実装）、`plow_gps/`（除雪車GPS仮データ、未実装）へ分離している。新しい収集元は既存サブパッケージへ混在させず、対応するサブパッケージへ追加する。道路タスクはTask IAM Roleを使い、アクセスキーやAWS CLIプロファイルをコンテナへ渡さない。`snow_pipe/`と`plow_gps/`は本MVPでは常にfixtureからの仮データであり、出力に`is_simulated: true`を保持する。
