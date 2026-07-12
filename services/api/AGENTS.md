# AI作業指示

このサービスは外部公開の唯一の入口である。S3を直接公開せず、PostgreSQLの派生データを取得してJSON/GeoJSONを返す。全ての道路・経路応答に`data_timestamp`、`confidence`、`is_simulated`を含め、入力検証・認可・エラー形式を一貫させる。
