# AI作業指示

このサービスはS3を正本として気象データを正規化し、AWS RDS PostgreSQLへロードする。`weather/window_loader.py`以外の旧Atom Normalizerやfixtureローダーを復活させない。

時間窓は`-3..0=observed`、`+1..3=forecast`の7件で固定する。必要時刻が欠けたら全体を失敗させる。S3 normalizedを書いた後、DBは単一トランザクションで冪等UPSERTし、`data_load_runs`へ追跡情報を記録する。DBは派生ストアであり、S3を介さない更新は禁止する。
