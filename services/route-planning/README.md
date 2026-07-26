# 経路探索サービス

PostgreSQL/PostGIS/pgRouting上の道路グラフと、確定済みの走りやすさ指数を用いて経路候補を作る。

- 走行不能、通行規制、低信頼度は明示的なコストまたは除外条件にする。
- 最短時間経路と安全優先経路を比較可能にする。
- 入力・出力には`data_timestamp`と使用した`rule_version`を残す。

道路グラフの生成と指数の決定はこのサービスの責務ではない。

`src/route_planning/`には公開リクエスト検証、最寄りedgeの実距離で判定するPostGIS地点スナップ、pgRouting K最短候補、独自コスト、危険区間集計、Lambda HTTPアダプターを置く。`tests/`では決定性、allow-list、候補の多様性、根拠集計を検証する。

本実装では独自の区間コストをグラフ版・指数版・基準時刻・モード・allow-list済み条件ごとのRDSキャッシュへ一度だけ生成し、PostGISで地点をスナップし、pgRoutingで方向付き探索と代替経路生成を行う。初回生成はadvisory lockで直列化し、同じ条件の再探索では全edgeの再集計を避ける。候補探索は出発地・目的地を囲む回廊内へ限定し、通常回廊で接続できない場合だけ広い回廊へ再探索する。AWS CDK、道路グラフ、公開`POST /v1/routes`はAWSへデプロイ・ロード済みである。2026-07-26に公開APIから3候補が返ることを確認した。

LLMは経路探索に関与しない。確定した経路レスポンスを`POST /v1/ai/explain-routes`へ渡すと、AIサービスが順位と数値を維持したまま比較説明を生成する。

APIレスポンスを既存Webへ接続せず確認する場合は、[ローカル経路マップビューア](tools/route-viewer/README.md)を使用する。詳細設計は[雪道経路探索サービス設計書](../../docs/architecture/route-planning-design.md)を参照する。
