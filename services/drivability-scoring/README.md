# 走りやすさ指数サービス

`curated/`の道路区間、対象時刻の気象、仮の消雪設備・除雪GPSを入力に、ルールベースで`score`（0〜100）と`confidence`（0〜1）を算出する。

- 出力の正本: S3 `curated/drivability-scores/snapshot_date=YYYY-MM-DD/...`
- 配信用投影: PostgreSQL `drivability_scores`
- 必須の根拠: `segment_id`、`data_timestamp`、適用ルール、入力値、`rule_version`、`is_simulated`

2026年1月23日・長岡市石動南町のデモでは、固定fixtureだけを使用する。LLMは指数を変更せず、確定済みの根拠を説明するだけに用いる。

`src/drivability_scoring/`には決定的なデモ用ルールエンジン、`tests/`には減点規則のテストを置く。運用ルールは`config/`、入出力契約は`docs/`、AI向け作業規約は`AGENTS.md`で管理する。
