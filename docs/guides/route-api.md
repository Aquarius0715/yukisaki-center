# 経路APIの実装・検証

## 現在の状態

道路収集、curated DB Loader、PostGIS/pgRoutingスキーマ、Route Planning Docker Lambda、`POST /v1/routes`、CDK、`env:start|stop|status`統合はローカル実装済みである。AWSへのデプロイと、ルーティング属性を含む長岡市道路の再収集・再ロードは未実施である。

既存AWSの道路には`source_node_key`、`target_node_key`等がないため、Route Planningスタックだけをデプロイしても経路APIは409を返す。次の順序を守る。

## デプロイ前確認

`infrastructure/cdk/`で実行する。

```bash
npm test
npm run build
npm run synth
```

RDSで利用可能な拡張を踏み台から確認する。

```sql
SHOW rds.extensions;
```

`postgis`と`pgrouting`が含まれない場合はデプロイを進めず、RDSエンジンバージョンを見直す。

## 反映順序

1. `YukisakiRoadCollector-dev`を更新する。
2. `YukisakiSnowPipePipeline-dev`を更新する。
3. `YukisakiRoutePlanning-dev`を作成する。
4. `YukisakiApi-dev`を更新して`POST /v1/routes`を追加する。
5. 道路Fargateタスクを手動実行する。
6. S3 raw、消雪パイプ処理、curatedロードの完了を確認する。
7. 全道路の走りやすさ指数を再計算する。
8. 経路APIを検証する。

道路ロードは`routing_edges`を先に削除し、`routing_nodes`とともに同一トランザクションで現在グラフへ切り替える。S3 curatedは引き続き正本である。

## API確認

```bash
API_URL="https://APIのURL"

curl -X POST "${API_URL}/v1/routes" \
  -H 'content-type: application/json' \
  -d '{
    "origin":{"latitude":37.4427,"longitude":138.7908},
    "destination":{"latitude":37.4510,"longitude":138.8050},
    "mode":"balanced",
    "options":{
      "avoid":[],
      "prefer":["recently_plowed"],
      "max_detour_minutes":10
    },
    "reference_time":"2026-01-23T12:00:00+09:00"
  }'
```

レスポンスでは`graph_version`、`score_rule_version`、`cost_config_version`、地点スナップ距離、最大3経路、指数カバレッジ、危険区間、`is_simulated`を確認する。

## DB確認

```sql
SELECT * FROM routing_graph_state;
SELECT count(*) FROM routing_nodes;
SELECT count(*) FROM routing_edges;
SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'pgrouting');
```

`routing_graph_state.edge_count`と`routing_edges`件数が一致し、デモ地点間に経路が存在することを確認してからWeb接続へ進む。
