# 入出力契約

入力は`segment_id`、`data_timestamp`、降雪量、気温、勾配、最終除雪時刻、消雪パイプ状態を含む。出力は0〜100の`score`、0〜1の`confidence`、加点・減点根拠、入力値、`rule_version`、`is_simulated`を含む。

初期表示前に`bootstrap-all-road-segments`モードで全道路区間を一括計算する。その後はGPS通過バッチごとに触れた道路区間だけを再計算し、先にS3 `curated/drivability-scores/`へ保存してからPostgreSQL `drivability_scores`へ冪等UPSERTする。指数は決定的ルールだけで計算し、LLMを呼ばない。
## 全道路初期計算

Lambda直接呼出しイベント`{"action":"score_all","dataTimestamp":"..."}`を受け、`road_segments`の全区間を指定時刻で計算する。`dataTimestamp`省略時はCDKのデモ基準時刻を使用する。run IDは時刻から決定的に生成し、同じ入力の再実行を冪等にする。

## GPS差分計算

GPS処理バッチの`segmentIds`と`latestObservedAt`を受け、通過した道路区間だけを再計算する。GPSのPostgreSQLロード完了を確認してから実行する。

両方式とも、先にS3 `curated/drivability-scores/`へJSON LinesとSHA-256を保存し、その後PostgreSQL `drivability_scores`へUPSERTする。指数は決定的ルールだけで計算し、LLMを呼ばない。
