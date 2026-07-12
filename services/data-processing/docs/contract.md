# 入出力契約

入力はS3 `raw/`オブジェクト、出力はS3 `normalized/`、`curated/`、quarantine、manifestである。DBロードは検証済み成果物に限り、`run_id`とロード元S3キーを`data_load_runs`へ記録する。
