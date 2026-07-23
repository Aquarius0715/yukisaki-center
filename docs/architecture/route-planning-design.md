# 雪道経路探索サービス設計書

## 1. 目的

新潟県長岡市全域の道路ネットワークに対し、所要時間だけでなく、道路区間ごとの走りやすさ指数、信頼度、勾配、消雪設備、除雪履歴、通行規制を考慮した候補経路を最大3件返す。

経路の数値、通行対象外区間、順位、危険区間は決定的なルールとグラフ探索で確定する。LLMは確定済み候補の説明だけを担当し、探索結果を変更しない。

PostGIS/pgRouting道路グラフ投影、公開経路API、Docker Lambda、AWS CDKは実装済みで、Route Planningスタックと公開API経路はAWSへデプロイ済みである。ルーティング属性を含む道路の再収集・再ロードは未完了であり、現在のAPIはDBに`routing_graph_state`がないため利用できない。

## 2. 結論

完全な自作ルーティングエンジンは作らない。次の分担とする。

| 領域 | 方針 |
|---|---|
| 道路データ | OpenStreetMapから収集し、独自`segment_id`と方向付きグラフを構築する |
| 区間コスト | 走りやすさ指数とプロジェクト固有ルールから自作する |
| 最短路・代替路アルゴリズム | PostGIS/pgRoutingのDijkstra・K shortest pathsを利用する |
| 地点検索 | Google Places等の外部APIを利用可能とする |
| 背景地図 | Google Mapsを利用する |
| 経路形状・順位 | 自システムの道路グラフから生成する |
| AI説明 | 自システムが確定した経路数値・根拠だけを入力する |

つまり、独自性が必要なのは探索アルゴリズムそのものではなく、道路区間と動的なコストを正しく結び付ける部分である。

## 3. 外部サービス・エンジン比較

| 選択肢 | 独自コスト | 最新指数との結合 | 運用 | 採否 |
|---|---|---|---|---|
| Google Routes API | 高速道路・有料道路等の一般的な回避条件が中心 | 独自`segment_id`単位の指数を直接注入できない | 最小 | 地点確認・標準経路との参考比較のみ |
| GraphHopper Directions API | Custom Modelで道路種別・速度・領域を調整可能 | 数秒単位で変わる全独自区間指数との同期には追加設計が必要 | SaaS利用は軽いが高度機能はプラン依存 | 将来比較候補 |
| GraphHopper self-hosted | 拡張可能 | 独自Encoded Valueやグラフ再構築が必要 | Javaサービスとグラフを別運用 | 対象地域拡大時の候補 |
| Valhalla self-hosted | 実行時Dynamic Costingを拡張可能 | 独自グラフタイルとRDS指数の同期実装が必要 | C++サービス・タイル運用が必要 | 現MVPには過大 |
| OSRM self-hosted | Lua profileで重み付け可能 | 動的指数更新に対する再カスタマイズ設計が必要 | 高速だが別グラフ運用 | 現MVPには不向き |
| PostGIS + pgRouting | SQLで任意の区間コストを渡せる | 共通RDSの`segment_id`で直接JOIN可能 | 既存RDSへ統合できる | **採用** |
| Python自作Dijkstra | 自由 | 自由 | グラフロード、並行実行、代替路、空間検索を自前管理 | 単体テスト用に限定 |

Google Routes APIの`routeModifiers`は、高速道路、有料道路、フェリー等を避ける用途であり、本プロジェクトの区間別指数を任意コストとして渡す用途には適合しない。GraphHopperのCustom ModelやValhallaのDynamic Costingは柔軟だが、RDSにある長岡市全域の独自区間ID・最新指数と外部グラフの対応を別途維持する必要がある。

Amazon RDS for PostgreSQLはPostGISとpgRoutingをサポートしている。デプロイ前に対象RDSで`SHOW rds.extensions`を実行し、実際に利用可能なバージョンを確認する。

参考資料:

- [Amazon RDS for PostgreSQL extension versions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html)
- [pgRouting documentation](https://docs.pgrouting.org/)
- [Google Routes API route modifiers](https://developers.google.com/maps/documentation/routes/route-modifiers)
- [GraphHopper Custom Model](https://docs.graphhopper.com/openapi/section/explore-our-apis/get-started)
- [Valhalla routing pipeline](https://valhalla.github.io/valhalla/route_overview/)

## 4. 現在のデータと実装前の不足

従来のAWS上の`road_segments`は地図表示と区間別属性の格納には使えるが、まだルーティング属性を含む道路で再ロードされていない。ローカル実装では次の項目を収集・curated・DB投影まで保持する。

| 項目 | 現在 | 経路探索に必要な対応 |
|---|---|---|
| `segment_id` | あり | 維持する |
| LineString | JSONB GeoJSON | PostGIS `geometry(LineString, 4326)`へ投影済み |
| 長さ | あり | 維持する |
| 始点・終点座標 | S3 GeoJSONに保持 | 安定node IDとPostGIS Pointへ正規化 |
| OSM `u/v` | 収集出力へ追加済み | OSM交差点と分割点の安定キーに使用 |
| 一方通行 | 収集出力へ追加済み | `cost/reverse_cost`へ反映 |
| 制限速度 | 正規化処理を実装済み | 欠損時は道路種別の既定速度を使用 |
| access/service | 正規化処理を実装済み | `open/closed/unknown`へ変換 |
| 橋梁・トンネル | S3 GeoJSONにはあり | edge属性として保持する |
| 勾配 | DB列はあるが実値は未整備 | 標高パイプライン後に反映する |
| 最新指数 | GPS通過区間を中心に一部あり | デモ対象全区間を指数または情報不足状態にする |
| 通行規制 | 未収集 | `open/closed/unknown`を区別する |

最初の実装工程は探索処理ではなく、道路収集からDBまで`source_node`、`target_node`、方向、速度、accessを失わずに運ぶグラフ生成である。

## 5. 道路グラフ設計

### 5.1 ノード

```sql
routing_nodes (
  node_id             bigint primary key,
  source_node_key     text unique not null,
  geometry            geometry(Point, 4326) not null,
  graph_version       text not null
)
```

- OSM交差点は`osm:{u}`または`osm:{v}`を安定キーにする。
- 約25m分割で追加された中間点は`split:{source_edge_id}:{boundary_index}`を安定キーにする。
- 座標が同じだけで上下線、橋、トンネルを接続しない。OSMノードまたは同一元edge上の連続性を正本とする。
- `node_id`はpgRouting用のbigint、外部契約には安定した文字列キーを使用する。

### 5.2 方向付きエッジ

```sql
routing_edges (
  edge_id               bigint primary key,
  segment_id            text not null references road_segments(segment_id),
  source                 bigint not null references routing_nodes(node_id),
  target                 bigint not null references routing_nodes(node_id),
  geometry               geometry(LineString, 4326) not null,
  length_m               numeric not null,
  road_type              text,
  speed_limit_kmh        numeric,
  effective_speed_kmh    numeric not null,
  base_travel_time_s     numeric not null,
  reverse_travel_time_s  numeric,
  oneway                 boolean not null,
  access_status          text not null,
  bridge                 boolean,
  tunnel                 boolean,
  max_slope_percent      numeric,
  graph_version          text not null,
  is_simulated           boolean not null
)
```

- 双方向道路は`reverse_travel_time_s`を設定する。
- 一方通行は逆方向をNULLとし、pgRoutingへ渡すとき`reverse_cost=-1`にする。
- 通行禁止・確定した通行止めは正方向も`cost=-1`として探索から除外する。
- 規制情報がない状態は`unknown`とし、`open`と同一視しない。
- GeometryへGiST index、`source`、`target`、`segment_id`へB-tree indexを作る。

### 5.3 グラフバージョン

道路スナップショットの`run_id`から`graph_version`を決める。同一リクエスト内で異なるグラフ版を混在させない。グラフを更新するときはステージングテーブルで品質検査し、1トランザクションで`active_graph_version`を切り替える。

品質検査は次を含む。

- source/targetが全て存在する
- 長さ0・空Geometryがない
- 一方通行が逆向き探索されない
- 主要デモ地点間に経路が存在する
- 連結成分、孤立ノード、行き止まり数を記録する
- 元の長岡市全域道路との対応件数を記録する

## 6. 地点スナップ

入力緯度経度から、PostGISで最寄りの利用可能な`routing_nodes`を検索する。

1. WGS84緯経度と対象地域内かを検証する。
2. 近傍の利用可能なedgeをGiST indexで検索する。
3. edgeの方向・accessを考慮して候補ノードを選ぶ。
4. 最大スナップ距離を100mとし、超える場合は400エラーにする。
5. 応答に入力座標、スナップ後座標、距離、node IDを含める。

道路は約25m区間に分割済みであるため、MVPでは最寄りノードへのスナップで開始する。将来、出発地点からedge途中までの正確な部分コストが必要になった場合は、pgRoutingのwithPoints系関数またはリクエスト内の仮想ノードを使用する。

Google Places等は地名・施設名を緯経度候補へ変換するためにだけ使用する。候補を利用者が確定した後、同じ地点スナップ処理へ渡す。

## 7. 区間コスト

### 7.1 基本時間

```text
base_travel_time_s = length_m / (effective_speed_kmh / 3.6)
```

`effective_speed_kmh`は、正規化できたOSM `maxspeed`を優先し、欠損時は設定ファイルの道路種別別既定速度を使用する。既定値を利用した区間は信頼度と根拠に記録する。

### 7.2 走りやすさコスト

```text
risk_ratio = (100 - drivability_score) / 100
uncertainty_ratio = 1 - confidence

edge_cost_s = base_travel_time_s
              * (1
                 + alpha * risk_ratio
                 + beta * uncertainty_ratio
                 + missing_data_penalty)
              + preference_penalty_s
```

| モード | alpha | beta | 方針 |
|---|---:|---:|---|
| `time_priority` | 0.2 | 0.2 | 時間優先。ただし極端な低指数を完全には無視しない |
| `balanced` | 1.0 | 0.5 | 時間と走りやすさを均衡 |
| `drivability_priority` | 3.0 | 1.0 | 遠回りを許容して走りやすさ・情報確度を優先 |

初期値は要件のalphaを維持する。beta、欠損ペナルティ、道路希望条件は非秘密のバージョン付き設定として管理し、実装後のシナリオテストで調整する。

### 7.3 欠損と規制

- `closed`: pgRoutingのcostを-1として必ず除外する。
- `open`: 通常どおり探索する。
- `unknown`: 通行可能と断定せず、探索は許可するが規制情報カバレッジと注意を返す。
- 指数なし: 架空の指数を補完せず、明示的な`missing_data_penalty`を使い、経路の指数カバレッジを返す。
- 低信頼度: 指数自体を変更せず、独立した不確実性コストとして扱う。

指数なし区間を全て除外すると経路が成立しない可能性が高いため、MVPでは許可＋情報不足ペナルティとする。ただし、デモ開始までに全道路を「指数あり」または「情報不足」としてスナップショット化する。

### 7.4 利用者条件

APIで許可する条件をallow-list化する。

- `avoid`: `steep_road`、`bridge`
- `prefer`: `main_road`、`recently_plowed`
- `max_detour_minutes`

これらは除外または設定済みペナルティへ変換する。クライアントから任意のSQL、任意の重み式、負のコストを受け取らない。LLMが抽出した条件も同じallow-listとサーバー検証を通す。

## 8. 候補経路生成

候補の多様性と再現性を両立するため、次の方式とする。

1. 選択モードの動的コスト表をリクエスト専用の一時テーブルへ作る。
2. `pgr_KSP`で上位候補を最大10件生成する。
3. edge集合の重複率が80%以上の候補を類似経路として除外する。
4. 最速候補から`max_detour_minutes`を超える候補を除外する。
5. 利用者が選択したモードのコストで順位を確定し、最大3件返す。

経路ラベルは計算結果から決定する。

- `fastest`: 時間が最短
- `balanced`: 選択モードで総合コスト最小
- `most_drivable`: 最低指数・加重平均指数を重視

ラベルと順位はLLMに決定させない。候補が1件しかない場合は1件だけ返し、無理に類似経路を複製しない。

## 9. 経路集計

各候補について次を計算する。

| 項目 | 算出方法 |
|---|---|
| 距離 | edgeの`length_m`合計 |
| 推定時間 | edgeの`base_travel_time_s`合計 |
| モードコスト | edgeの`edge_cost_s`合計 |
| 平均指数 | 距離加重平均。指数あり区間だけで算出 |
| 最低指数 | 指数あり区間の最小値 |
| 指数カバレッジ | 指数あり区間長 / 全経路長 |
| 最低信頼度 | 経路上の最小confidence |
| 危険区間数 | 指数40未満等の連続区間群数 |
| 除雪済み割合 | 指定時間内に除雪された区間長割合 |
| 急勾配・橋梁 | 該当区間数・距離 |
| 規制情報カバレッジ | `open/closed`確認済み区間長割合 |

平均指数が高くても最低指数が低い経路があるため、両方を必ず返す。指数カバレッジが100%未満の場合は平均値だけで安全性を断定しない。

連続する危険区間はGeometryが連続し、同じ主要因を持つ場合に1つの`hazard_group`へ集約する。AIへ渡すのは集約済みの根拠である。

## 10. API契約

### 10.1 リクエスト

```http
POST /v1/routes
Content-Type: application/json
```

```json
{
  "origin": {"latitude": 37.4427, "longitude": 138.7908},
  "destination": {"latitude": 37.4510, "longitude": 138.8050},
  "mode": "balanced",
  "options": {
    "avoid": ["steep_road", "bridge"],
    "prefer": ["main_road", "recently_plowed"],
    "max_detour_minutes": 10
  },
  "reference_time": "2026-01-23T12:00:00+09:00"
}
```

- 緯経度は通常フォーム、地図クリック、または確定済み地点候補から受け取る。
- `reference_time`はデモでは固定時刻だけを許可する。
- `mode`、`avoid`、`prefer`は列挙値以外を拒否する。
- 入力本文サイズ、経由地数、探索距離へ上限を設ける。

### 10.2 レスポンス

```json
{
  "request_id": "route-request-...",
  "mode": "balanced",
  "reference_time": "2026-01-23T12:00:00+09:00",
  "graph_version": "road-run-...",
  "score_rule_version": "drivability-v1",
  "data_timestamp": "2026-01-23T12:00:00+09:00",
  "is_simulated": true,
  "snapped_points": {
    "origin": {"distance_m": 8.2, "node_id": "..."},
    "destination": {"distance_m": 11.4, "node_id": "..."}
  },
  "routes": [
    {
      "route_id": "route-...",
      "rank": 1,
      "label": "balanced",
      "geometry": {"type": "LineString", "coordinates": []},
      "segment_ids": [],
      "distance_m": 3200,
      "duration_s": 480,
      "weighted_cost_s": 625.4,
      "average_drivability_score": 72.4,
      "minimum_drivability_score": 51,
      "score_coverage": 1.0,
      "minimum_confidence": 0.8,
      "hazard_group_count": 2,
      "hazard_groups": [],
      "is_simulated": true
    }
  ],
  "warnings": []
}
```

`route_id`は、正規化したリクエスト、グラフ版、指数版、edge列から決定的に生成する。同じ入力・同じデータ版で同じ結果を再現できるようにする。

### 10.3 エラー

| HTTP | 条件 |
|---|---|
| 400 | 入力不正、地点が対象範囲外、道路から100m超 |
| 404 | 有効な経路が存在しない |
| 409 | 指定時刻に対応するグラフ・指数版が揃っていない |
| 503 | RDS停止、探索タイムアウト、一時障害 |

経路がない場合、通行可能であるかのように直線を返したり、Google経路へ暗黙にフォールバックしたりしない。

## 11. サービス境界

```text
Web / AI入力確認済み条件
        |
        v
API Gateway POST /v1/routes
        |
        v
route-planning Docker Lambda
        |
        +--> PostGIS: 地点スナップ
        +--> pgRouting: 候補生成
        +--> PostgreSQL: 指数・根拠集計
        |
        v
確定済み候補JSON / GeoJSON
        |
        +--> Web表示
        +--> ai-assistant説明入力
```

API Gatewayを公開の入口とし、経路探索は`services/route-planning`のDockerイメージLambdaへ直接統合する。既存API Lambdaから同期Lambda呼び出しは行わない。これにより、API Gatewayという単一公開境界を維持しつつ、API整形と経路探索のコード責務を分離する。

低頻度のMVPではFargate常駐サービスよりLambdaを優先する。探索がLambdaの時間・メモリ制約を継続的に超える、対象地域が大幅に拡大する、またはGraphHopper/Valhallaを採用する段階でECS Fargate Serviceへ移行する。

## 12. AWS構成

`YukisakiRoutePlanning-dev`スタックを実装する。

| リソース | 方針 |
|---|---|
| Route Lambda | Docker image、ARM64、private isolated subnet |
| DB | 既存の共通RDS PostgreSQL 16 |
| 拡張 | PostGIS、pgRouting |
| Secret | 既存の共通Secrets Manager Secret |
| Security Group | Route LambdaからRDS 5432だけを許可 |
| API | 既存HTTP APIへ`POST /v1/routes`を追加 |
| Logs | CloudWatch Logs、1か月保持 |
| Timeout | 初期20秒、API目標は5秒以内 |
| Lifecycle | デプロイ時は予約同時実行数0、`env:start/stop/status`へ統合 |

API GatewayのCORSへPOSTと`content-type`を追加する。公開経路APIにDB認証情報や任意SQLを渡さない。

RDS停止中は探索しない。S3 curated道路・指数を正本として維持し、RDSのグラフ・投影を再作成可能にする。

## 13. 外部APIの利用範囲

### 採用候補

- Google Places / Geocoding: 地名・施設名から緯経度候補を取得
- Google Maps JavaScript API: 背景地図と独自GeoJSON経路の描画
- Google Routes API: 開発時の標準所要時間との比較検証

### 使用しない範囲

- 外部Routes APIの順位を本システムの推奨順位として利用しない
- 外部経路を独自道路へ正確にマッチできない状態で指数を付与しない
- 外部API失敗時に推測した地点・経路を返さない
- Google Mapsの標準経路と独自経路が一致することを前提にしない

外部の所要時間を校正に利用する場合も、元値、取得時刻、利用規約、キャッシュ制限を確認し、独自コストと混同しない。

## 14. セキュリティと再現性

- 入力地点は対象bboxと型を検証する。
- モード・条件はallow-listで検証する。
- pgRoutingへ渡すSQLは固定し、利用者入力を文字列連結しない。
- LambdaのDBユーザーは経路探索に必要なSELECTと関数実行だけに限定する。
- `request_id`、入力、グラフ版、指数版、設定版、処理時間、候補数を構造化ログへ記録する。
- 緯経度ログの保持期間とアクセス権限を設定する。
- 同一データ版の結果が再現できるfixtureテストを持つ。

## 15. 性能設計

MVPの目標はAPI全体5秒以内、DB探索部分2秒以内とする。

最初に次を計測する。

- 地点スナップ時間
- KSP K=10の時間
- Geometry結合時間
- 危険区間集計時間
- RDS CPU・接続数
- Lambda cold/warm duration

長岡市全域の再収集後の区間数でpgRoutingの性能を実測して判断する。インデックス、SQL、候補Kを先に調整し、根拠なく大型インスタンスへ変更しない。

## 16. テスト方針

### グラフ品質

- 全edgeのsource/targetが存在する
- 双方向・一方通行が正しく探索される
- 橋や立体交差が座標一致だけで誤接続されない
- 固定道路入力から同じnode/edge IDが生成される
- デモ主要地点間が接続している

### コスト

- alpha変更により経路が変化し得る
- 通行止めが必ず除外される
- 低信頼度が指数そのものを変更しない
- 指数欠損時に架空値を作らない
- 負の通常コストを生成しない

### シナリオ

- 時間優先と走りやすさ優先が異なる経路を返す
- 最短経路に低指数区間、迂回路に高指数区間がある
- 一方通行で逆向き経路が禁止される
- 通行止めにより迂回する
- 候補が類似する場合に重複排除される
- 道路外100m超の地点を拒否する
- 指数カバレッジ不足を警告する
- 同一入力・版で同じroute IDと順位になる

## 17. 実装・反映順序

ローカル実装は手順1、2、6〜9まで完了している。AWSへ反映するときは、手順3〜5の実環境確認と再ロードを省略しない。

1. 道路データ契約へOSM `u/v`、方向、速度、accessを追加する。
2. 安定したrouting node/edgeをS3 curatedへ生成する。
3. RDSでPostGIS・pgRoutingの対応版を確認し、拡張を有効化する。
4. `routing_nodes`、`routing_edges`をロードし、グラフ品質を検証する。
5. 全道路の指数または情報不足スナップショットを作る。
6. 固定fixtureでコスト関数とDijkstraを検証する。
7. 地点スナップとKSP候補生成を追加する。
8. 集計・危険区間グルーピングを追加する。
9. `POST /v1/routes`とAWSスタックを追加する。
10. Web表示、最後にAI比較説明を接続する。

最初から外部ルーティングエンジン、Fargate常駐、ターンバイターン案内まで同時に追加しない。まず固定デモ地点間で、方向・コスト・候補3件・根拠が正しい縦切りを完成させる。

## 18. デプロイ前に実データで検証する事項

次の値にはバージョン付き初期値とfixtureテストがあるが、長岡市全域の再収集後に妥当性を検証する。

- 道路種別別の既定速度
- betaと指数欠損ペナルティ
- `unknown`規制区間のペナルティ
- 候補類似度80%の妥当性
- 最大スナップ距離100mの妥当性
- `max_detour_minutes`の既定値
- 初回デモの出発地・目的地
- Google Placesを今回のMVPへ含めるか、地図クリックだけで開始するか

これらはコードへ直書きせず、設定版とテストケースを持つ。
