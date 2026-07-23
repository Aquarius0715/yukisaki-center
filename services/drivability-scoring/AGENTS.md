# AI作業指示

このサービスは走りやすさ指数を決定する唯一の場所である。デモ開始時は`score_all`で全道路を一括評価し、その後はGPS通過データのDB反映後にSQSから通過区間を差分評価する。気象、道路勾配、消雪パイプ、最終除雪時刻を決定的なルールへ入力する。入力値、適用ルール、`rule_version`、`is_simulated`を必ず出力し、S3 `curated/drivability-scores/`を保存してからPostgreSQLへ投影する。LLMや推測値を指数計算へ混ぜない。
