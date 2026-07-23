# 入出力契約

入力は`segment_id`、`data_timestamp`、降雪量、気温、勾配、最終除雪時刻、消雪パイプ状態を含む。出力は0〜100の`score`、0〜1の`confidence`、加点・減点根拠、入力値、`rule_version`、`is_simulated`を含む。

初期表示前に`bootstrap-all-road-segments`モードで全道路区間を一括計算する。その後はGPS通過バッチごとに触れた道路区間だけを再計算し、先にS3 `curated/drivability-scores/`へ保存してからPostgreSQL `drivability_scores`へ冪等UPSERTする。指数は決定的ルールだけで計算し、LLMを呼ばない。
