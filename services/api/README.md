# REST APIサービス

WebとAIサービスに、道路区間、指数、経路候補、根拠データを提供する唯一の公開バックエンドである。

初期エンドポイントは、要件定義書の`/v1/road-segments`、`/v1/routes`、`/v1/route-comparisons`、`/v1/hazard-explanations`に従う。レスポンスには必ず`data_timestamp`、`confidence`、`is_simulated`を含める。

APIはS3を直接走査せず、PostgreSQLの配信用投影を参照する。再計算や再ロードは内部サービスから行い、公開APIへ混在させない。

現在はAPI Gateway HTTP APIとDockerイメージLambdaで、共通PostgreSQLの配信用投影を読み取り専用で公開する。道路、最新の走りやすさ指数、消雪パイプ、最終除雪時刻と、3台の除雪車の最新位置をGeoJSONで返す。道路は`bbox`で表示範囲を絞り、除雪車は別エンドポイントをポーリングできるため、大きな道路形状を5秒ごとに再取得する必要はない。

経路探索は同じHTTP APIの`POST /v1/routes`から公開し、`route-planning`サービスがPostGISとpgRoutingを使って最大3候補を計算する。APIサービスは公開入口を所有し、経路計算ロジックや重み付けは所有しない。

地点名称検索は同じHTTP APIの`GET /v1/places/search`と`GET /v1/places/autocomplete`から公開する。Apple Maps Server API専用LambdaをVPC外へ分離し、長岡市内に限定した座標候補を返す。ブラウザ用MapKit JSトークンは流用しない。

DB参照Lambdaはprivate subnetに配置し、Secrets Managerの共通認証情報でRDSへ接続する。地点検索LambdaはDBへ接続せず、Apple Maps専用Secretだけを読み取る。API GatewayとRDSを直接接続せず、DBやシークレットを公開しない。AWS実行は`infrastructure/cdk`の`env:start|stop|status`で管理する。

テストは`tests/`、API契約は`docs/`、設定方針は`config/`、AI向け作業規約は`AGENTS.md`に分離する。

システム構成、データ結合、性能、セキュリティ、運用の設計は[地図・除雪車REST API設計書](../../docs/architecture/map-api-design.md)を参照する。
地点検索の設定と確認は[Apple Maps地点検索API](../../docs/guides/place-search-api.md)を参照する。
