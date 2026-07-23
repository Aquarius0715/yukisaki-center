# 経路探索サービス

PostgreSQL/PostGIS/pgRouting上の道路グラフと、確定済みの走りやすさ指数を用いて経路候補を作る。

- 走行不能、通行規制、低信頼度は明示的なコストまたは除外条件にする。
- 最短時間経路と安全優先経路を比較可能にする。
- 入力・出力には`data_timestamp`と使用した`rule_version`を残す。

道路グラフの生成と指数の決定はこのサービスの責務ではない。

`src/route_planning/`には公開リクエスト検証、PostGIS地点スナップ、pgRouting K最短候補、独自コスト、危険区間集計、Lambda HTTPアダプターを置く。`tests/`では決定性、allow-list、候補の多様性、根拠集計を検証する。

本実装では独自の区間コストを共通RDS上の一時テーブルへパラメーター化して組み立て、PostGISで地点をスナップし、pgRoutingで方向付き探索と代替経路生成を行う。AWS CDKと公開`POST /v1/routes`はAWSへデプロイ済みだが、新しい道路グラフの再ロードは未完了である。

APIレスポンスを既存Webへ接続せず確認する場合は、[ローカル経路マップビューア](tools/route-viewer/README.md)を使用する。詳細設計は[雪道経路探索サービス設計書](../../docs/architecture/route-planning-design.md)を参照する。
