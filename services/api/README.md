# REST APIサービス

WebとAIサービスに、道路区間、指数、経路候補、根拠データを提供する唯一の公開バックエンドである。

初期エンドポイントは、要件定義書の`/v1/road-segments`、`/v1/routes`、`/v1/route-comparisons`、`/v1/hazard-explanations`に従う。レスポンスには必ず`data_timestamp`、`confidence`、`is_simulated`を含める。

APIはS3を直接走査せず、PostgreSQLの配信用投影を参照する。再計算や再ロードは内部サービスから行い、公開APIへ混在させない。

現在の`src/server.py`は`/healthz`とデモ用の`/v1/road-segments`を提供する依存なしのREST境界である。PostgreSQLクエリ・認可は次の段階で追加する。テストは`tests/`、API契約は`docs/`、設定方針は`config/`、AI向け作業規約は`AGENTS.md`に分離する。
