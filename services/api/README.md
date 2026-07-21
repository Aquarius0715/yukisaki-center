# REST APIサービス

WebとAIサービスに、道路区間、指数、経路候補、根拠データを提供する唯一の公開バックエンドである。

初期エンドポイントは、要件定義書の`/v1/road-segments`、`/v1/routes`、`/v1/route-comparisons`、`/v1/hazard-explanations`に従う。レスポンスには必ず`data_timestamp`、`confidence`、`is_simulated`を含める。

APIはS3を直接走査せず、PostgreSQLの配信用投影を参照する。再計算や再ロードは内部サービスから行い、公開APIへ混在させない。

現在はAPI Gateway HTTP APIとDockerイメージLambdaで、共通PostgreSQLの配信用投影を読み取り専用で公開する。道路、最新の走りやすさ指数、消雪パイプ、最終除雪時刻と、3台の除雪車の最新位置をGeoJSONで返す。道路は`bbox`で表示範囲を絞り、除雪車は別エンドポイントをポーリングできるため、大きな道路形状を5秒ごとに再取得する必要はない。

Lambdaはprivate subnetに配置し、Secrets Managerの共通認証情報でRDSへ接続する。API GatewayとRDSを直接接続せず、DBやシークレットを公開しない。AWS実行は`infrastructure/cdk`の`env:start|stop|status`で管理する。

テストは`tests/`、API契約は`docs/`、設定方針は`config/`、AI向け作業規約は`AGENTS.md`に分離する。

システム構成、データ結合、性能、セキュリティ、運用の設計は[地図・除雪車REST API設計書](../../docs/architecture/map-api-design.md)を参照する。
