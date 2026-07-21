# AI作業指示

このサービスはS3を正本として気象を正規化し、道路と消雪パイプ仮データを統合してAWS RDS PostgreSQLへロードする。気象では`weather/window_loader.py`以外の旧Atom Normalizerやfixtureローダーを復活させない。道路・消雪パイプは`curated/road-segments/`を保存してからSQS経由でDBへロードし、収集処理から直接DBへ書かない。

時間窓は`-3..0=observed`、`+1..3=forecast`の7件で固定する。必要時刻が欠けたら全体を失敗させる。S3 normalizedを書いた後、DBは単一トランザクションで冪等UPSERTし、`data_load_runs`へ追跡情報を記録する。DBは派生ストアであり、S3を介さない更新は禁止する。
