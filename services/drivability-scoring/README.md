# 走りやすさ指数サービス

`curated/`の道路区間、対象時刻の気象、仮の消雪設備・除雪GPSを入力に、ルールベースで`score`（0〜100）と`confidence`（0〜1）を算出する。

- 出力の正本: S3 `curated/drivability-scores/snapshot_date=YYYY-MM-DD/...`
- 配信用投影: PostgreSQL `drivability_scores`
- 必須の根拠: `segment_id`、`data_timestamp`、適用ルール、入力値、`rule_version`、`is_simulated`

デモ開始時は対象範囲の全道路へ初期スナップショットを作成する。その後はGPS通過バッチが触れた道路区間だけを再計算し、最新値をAPIへ反映する。どちらもS3保存後にPostgreSQLへ冪等UPSERTする。

2026年1月23日・長岡市全域のデモでは、固定スナップショットだけを使用する。各道路には最も近い気象グリッド地点を適用する。LLMは指数を変更せず、確定済みの根拠を説明するだけに用いる。

全道路初期計算の実行方法は[GPSパイプラインガイド](../../docs/guides/gps-pipeline.md)、入出力は[契約](docs/contract.md)を参照する。
