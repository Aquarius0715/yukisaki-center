# AI作業指示

このサービスはS3を正本として気象を正規化し、道路・消雪パイプ・除雪車GPSを処理してAWS RDS PostgreSQLへロードする。気象では`weather/window_loader.py`以外の旧Atom Normalizerやfixtureローダーを復活させない。道路・消雪パイプは`curated/road-segments/`、GPSは`normalized/simulated/plow-gps/`と`curated/snowplow-passages/`を保存してからSQS経由でDBへロードし、収集処理から直接DBへ書かない。

時間窓は各地点につき`-3..0=observed`、`+1..3=forecast`の7件で固定し、長岡市全域35地点で245件とする。1地点でも必要時刻が欠けたら全体を失敗させる。GPSはcurated道路に空間グリッドを使って最近傍マッチングし、最新位置と通過履歴へ分ける。S3へ書いた後、DBは単一トランザクションで冪等UPSERTし、`data_load_runs`へ追跡情報を記録する。DBは派生ストアであり、S3を介さない更新は禁止する。
