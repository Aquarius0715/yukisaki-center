# 経路探索サービス

PostgreSQL/PostGIS/pgRouting上の道路グラフと、確定済みの走りやすさ指数を用いて経路候補を作る。

- 走行不能、通行規制、低信頼度は明示的なコストまたは除外条件にする。
- 最短時間経路と安全優先経路を比較可能にする。
- 入力・出力には`data_timestamp`と使用した`rule_version`を残す。

道路グラフの生成と指数の決定はこのサービスの責務ではない。

`src/route_planning/`にはデモ用の最短コスト探索、`tests/`には経路選択テストを置く。PostGIS/pgRoutingへ移行しても、`config/`のコスト方針と`docs/`の契約を維持する。
