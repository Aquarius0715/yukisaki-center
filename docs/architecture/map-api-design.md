# 地図・除雪車REST API設計書

## 1. 目的

Webフロントエンドへ、道路形状、走りやすさ指数、消雪パイプ、最終除雪情報、除雪車3台の最新位置をHTTPSのJSON / GeoJSON APIとして提供する。

本APIはS3原本を直接公開せず、S3 curatedから再作成可能な共通RDS PostgreSQLの配信用投影を読み取る。公開APIからデータ投入、再計算、収集処理を実行させない。

デモの固定条件は次のとおりである。

- 対象地域: 新潟県長岡市全域
- 対象日: 2026年1月23日
- 除雪車: 3台のシミュレーションデータ
- 仮データは`is_simulated: true`として返し、画面にもデモデータであることを表示する

## 2. 対象範囲

### 2.1 対象

- 地図表示範囲内の道路GeoJSON取得
- 道路区間1件の詳細取得
- 除雪車3台の最新位置GeoJSON取得
- 初回表示用の道路・除雪車一括取得
- Apple Maps Server APIによる長岡市内の地点名称検索・入力補完
- 道路IDと除雪車の走行中道路の紐付け
- CORS、入力検証、共通エラー形式
- 開発・デモ環境の一括起動・停止

### 2.2 対象外

- 経路探索
- 自然言語解析、危険説明
- GPSや消雪パイプの投入用公開API
- WebSocketによるプッシュ配信
- ユーザー認証、管理者API
- ベクトルタイル配信

## 3. 通信方式の設計判断

現在はREST方式を採用する。

| データ | 取得方式 | フロントエンドの取得タイミング |
|---|---|---|
| 道路形状・指数 | REST | 初回表示、地図表示範囲の変更時 |
| 除雪車最新位置 | REST | 初回表示後、約5秒間隔でポーリング |
| 道路・除雪車一括 | REST | 初回表示、切断・エラー後の再同期 |

道路データは更新頻度が低く、除雪車位置は小さいデータが高頻度で更新される。このため、道路と除雪車を別エンドポイントにし、位置更新のたびに道路GeoJSONを再取得しない。

現在の3台・5秒間隔ではRESTポーリングで十分である。1秒未満の更新、車両数・同時閲覧者の大幅な増加が必要になった場合に限り、除雪車差分配信をWebSocketへ追加する。道路GeoJSONは将来もRESTまたはベクトルタイルで配信する。

## 4. AWS構成

```text
Webブラウザ
    |
    | HTTPS GET / CORS
    v
Amazon API Gateway HTTP API
    +-- Map API Lambda（Docker image / ARM64 / isolated subnet）
    |           |
    |           +--> AWS Secrets Manager
    |                 共通DB認証情報
    |
    | TLS / TCP 5432
    v
Amazon RDS for PostgreSQL `yukisaki`
    |
    +-- road_segments_enriched
    +-- drivability_scores
    +-- snowplow_segment_passages
    +-- snowplow_positions_latest
    +-- snowplow_vehicles
    |
    +-- Place Search Lambda（Docker image / ARM64 / VPC外）
          |
          +-- Secrets Manager（Apple Maps専用秘密鍵）
          +-- Apple Maps Server API（HTTPS）
```

| コンポーネント | 設計 |
|---|---|
| CDKスタック | `YukisakiApi-dev` |
| API | API Gateway HTTP API、デフォルトステージ、HTTPS |
| 実行基盤 | Lambda Dockerイメージ、Python 3.13、ARM64 |
| Lambda設定 | 1,024 MB、タイムアウト20秒、デプロイ直後の予約同時実行数0 |
| ネットワーク | 共通DB VPCのprivate isolated subnet |
| DB接続 | API専用Security GroupからRDSの5432番だけを許可 |
| DB認証 | Secrets Managerの共通認証情報、Lambda IAM Roleに読取り権限を付与 |
| ログ | CloudWatch Logs、保持期間1か月 |
| CORS | 現在は`*`、GETのみ |

API Gatewayは公開するが、Lambda、RDS、Secrets Managerは公開しない。API GatewayからRDSへ直接接続せず、Lambdaを読み取り境界とする。

## 5. アプリケーション構成

```text
services/api/
  src/yukisaki_api/
    handler.py       HTTP API v2イベント、ルーティング、CORS、エラー変換
    service.py       入力検証、bbox判定、GeoJSON組立、メタデータ集約
    repository.py    Secrets Manager、PostgreSQL接続、読取りSQL
  tests/test_api.py  API・サービス単体テスト
  docs/contract.md   外部API契約
  Dockerfile         test / runtime / Lambdaイメージ

infrastructure/cdk/
  lib/api-stack.ts   API Gateway、Lambda、IAM、SG、Logs
  test/api-stack.test.ts
```

責務は次のように分ける。

- `handler`: HTTP固有処理だけを担当する
- `service`: DBの行を公開用GeoJSONへ変換する
- `repository`: DBアクセスを読み取り専用で担当する
- `api-stack`: AWSリソースと接続権限だけを定義する

## 6. エンドポイント

| メソッド | パス | 用途 | DB参照 |
|---|---|---|---|
| GET | `/healthz` | LambdaのLiveness確認 | なし |
| GET | `/v1/road-segments` | 表示範囲の道路GeoJSON | あり |
| GET | `/v1/road-segments/{id}` | 道路区間1件 | あり |
| GET | `/v1/snowplows` | 除雪車の最新位置 | あり |
| GET | `/v1/map/snapshot` | 道路と除雪車の一括取得 | あり |
| GET | `/v1/places/search` | 名称から長岡市内の座標候補を取得 | なし |
| GET | `/v1/places/autocomplete` | 長岡市内の名称入力を補完 | なし |

`/healthz`はLambdaが呼び出せることだけを確認する。RDSの起動状態を確認するReadinessではない。

### 6.1 道路検索パラメータ

| パラメータ | 必須 | 形式 | 既定値・制限 |
|---|---|---|---|
| `bbox` | いいえ | `west,south,east,north` | `138.643056,37.176389,139.124444,37.710278` |
| `limit` | いいえ | 整数 | 既定5,000、1〜5,000 |

緯度は-90〜90、経度は-180〜180とし、`west < east`、`south < north`を必須とする。上限を超える道路がある場合は`truncated: true`を返し、フロントエンドがbboxを狭めて再取得する。

## 7. データ取得と結合

### 7.1 道路

`road_segments`を基点に、bboxで対象道路を先に絞ってから各道路区間の最新情報を結合する。

| 公開プロパティ | PostgreSQL取得元 |
|---|---|
| `segment_id`、道路形状・名称・種別・勾配 | `road_segments` |
| `snow_pipe`、稼働状態、効果 | `snow_pipe_history`の区間別最新行 |
| `drivability_score`、根拠、信頼度 | `drivability_scores`の区間別最新行 |
| `last_plowed_at`、`last_plowed_by` | `snowplow_segment_passages`の区間別最新行 |

道路はLineStringまたはMultiLineStringのGeoJSON Featureとして返す。`feature.id`と`properties.segment_id`は同じ値とする。

道路ロード時にGeoJSONから`min_longitude`、`min_latitude`、`max_longitude`、`max_latitude`を計算して`road_segments`へ保持し、複合インデックスを作成する。APIはこの外接矩形とリクエスト`bbox`の交差条件、`LIMIT + 1`をSQLへ渡し、該当道路だけをLambdaへ返す。`LIMIT + 1`件目の有無で`truncated`を判定する。将来、より複雑な形状検索や経路探索が必要になった段階でPostGIS/GiST、ページング、MVT配信への移行を判断する。

### 7.2 除雪車

`snowplow_positions_latest`と`snowplow_vehicles`を結合し、車両ごとに最新位置1件を返す。

- Geometry: Point
- 座標順: `[longitude, latitude]`
- `matched_segment_id`: 直近のマップマッチング先道路ID
- `operation`: 除雪作業状態
- `run_id`: データ生成・ロードの追跡ID
- `is_simulated`: 常にデモデータであることを明示

フロントエンドは`matched_segment_id`と道路Featureの`segment_id`を同じキーとして扱う。

## 8. 応答メタデータ

全道路・除雪車応答へ次を含める。

| 項目 | ルール |
|---|---|
| `data_timestamp` | 使用データの対象時刻。コレクションではFeatureの最大値 |
| `confidence` | 道路は指数の信頼度、指数なしは0.5。除雪車位置は現在0.9 |
| `is_simulated` | 含まれる道路付加情報、指数、GPSのいずれかが仮データならtrue |

道路Featureの`data_timestamp`は、指数時刻、消雪パイプ更新時刻、道路スナップショット日の順で採用する。`/v1/map/snapshot`では道路・除雪車のうち新しい時刻を全体の`data_timestamp`とする。

APIスキーマのバージョンは、一括レスポンスの`schema_version: "1.0"`で表す。後方互換性を壊す変更は`/v2`またはメジャーバージョン更新として扱う。

## 9. フロントエンド連携

推奨する取得順序は次のとおりである。

```text
画面表示
  -> GET /v1/road-segments?bbox=...&limit=75
     とGET /v1/snowplowsを並列実行
  -> 現在の表示範囲の道路75件を即時描画
  -> next_cursorのページはブラウザへ自動蓄積しない
  -> 除雪車マーカー3台生成
  -> 5秒ごとにGET /v1/snowplows
  -> 同じvehicle_idのマーカー位置・向きだけ更新

地図移動
  -> debounce後に進行中の道路リクエストを中断
  -> GET /v1/road-segments?bbox=...&limit=75
  -> 現在の1ページで道路レイヤーを差し替え
```

- 除雪車マーカーのキーには`vehicle_id`を使う
- 道路レイヤーのキーには`segment_id`を使う
- `heading_degrees`で車両アイコンを回転する
- `observed_at`が現在表示中の値より古い応答は反映しない
- `is_simulated: true`の場合は「デモデータ」と表示する
- `next_cursor`はAPI利用者が明示的に続きのページを必要とする場合に使用する。Web地図は自動取得しない
- 1回の表示では最大1,000道路に抑え、広域表示でブラウザのメモリを圧迫しない
- 503時は指数・位置を推定せず、最終正常データの時刻と「更新停止」を表示する

## 10. エラー設計

| HTTP | `error.code` | 条件 |
|---|---|---|
| 400 | `invalid_request` | bbox、limit、道路IDの入力不正 |
| 404 | `not_found` | パスまたは道路区間が存在しない |
| 405 | `method_not_allowed` | GET以外 |
| 503 | `service_unavailable` | RDS停止、DBタイムアウト、内部一時障害 |

内部例外、SQL、DBホスト、Secrets Manager ARN、認証情報はレスポンスへ含めない。詳細はCloudWatch Logsへ記録する。

`env:stop`中はLambdaの予約同時実行数が0になるため、API GatewayまたはLambdaが429を返す場合がある。これは開発環境の意図した停止状態であり、利用前に`env:start`を実行する。

## 11. セキュリティ

- 通信はAPI GatewayのHTTPSのみ
- RDSはprivate subnetに置き、Public accessを無効化
- RDSの5432番はAPI専用Security Groupからだけ許可
- DB接続は`sslmode=require`
- DBシークレットは環境変数へ直接格納せず、ARNだけを渡す
- Lambda IAM Roleには対象Secretの読取りだけを許可
- 公開APIはGETのみで、データ変更機能を持たない
- CORSはデモ開発中のみ`*`

本番公開時はCORSをWeb配信ドメインへ限定し、必要に応じてJWT認証、レート制限、AWS WAFを追加する。管理・投入・再計算APIは本公開APIへ追加しない。

## 12. 性能・可用性

| 項目 | 現在値 |
|---|---|
| Lambda timeout | 20秒 |
| PostgreSQL connect timeout | 5秒 |
| PostgreSQL statement timeout | 12秒 |
| 道路API上限 | 5,000件/ページ |
| Webページサイズ | 表示範囲ごとに75件、MapKitへは1ページだけ描画 |
| HTTPキャッシュ | `Cache-Control: no-store` |
| 除雪車ポーリング | 約5秒 |

RDS停止中はAPIデータを提供しない。S3は正本として維持されるため、RDSは再ロード可能である。外部データの欠損時にAPIやLLMが値を推定してはならない。

今後、閲覧数が増えた場合は次の順で改善する。

1. PostGIS/GiSTでbbox検索を高度化
2. ETagまたは短時間キャッシュを道路レスポンスへ追加
3. 道路をMVT化してS3・CloudFrontから配信
4. 除雪車位置だけをWebSocket差分配信へ変更
5. RDS Proxyまたは接続プールを導入

## 13. 監視・テスト

監視対象は次のとおりである。

- API Gatewayの4xx、5xx、レイテンシ
- LambdaのErrors、Duration、Throttles、ConcurrentExecutions
- CloudWatch Logsの`ERROR`
- RDSの接続数、CPU、空きストレージ
- APIレスポンスの道路件数、除雪車件数、`data_timestamp`

テストは次の層に分ける。

| テスト | 内容 |
|---|---|
| API単体テスト | GeoJSON、bbox、limit、404、必須メタデータ |
| CDKテスト | API Gateway 5 Route、Docker Lambda、ARM64、予約同時実行数0、DB SG |
| スモークテスト | `/healthz`、道路、除雪車3台、一括取得、CORS |
| ライフサイクル | `env:start`で利用可能、`env:stop`でLambda・RDS・GPS停止 |

## 14. 起動・停止とデプロイ

作業ディレクトリは`infrastructure/cdk/`とする。

```bash
# 起動
npm run env:start -- --profile yukisaki-dev

# URLと状態の確認
npm run env:status -- --profile yukisaki-dev

# 停止
npm run env:stop -- --profile yukisaki-dev
```

`env:start`は共通RDS、API Lambda、GPS Simulator、関連処理を起動する。`env:stop`はAPI Lambdaを予約同時実行数0にし、GPS Simulatorを0タスク、RDSを停止状態へ移行する。API Gateway、ECRイメージ、CloudWatch Logsは維持する。

現在のAWS API URLは次のとおりである。

```text
https://ird5uq7fr1.execute-api.ap-northeast-1.amazonaws.com
```

URLをコードへ直書きせず、フロントエンドの環境変数`VITE_YUKISAKI_API_URL`等へ設定する。

## 15. 関連資料

- [API契約](../../services/api/docs/contract.md)
- [フロントエンド接続手順](../guides/frontend-map-api.md)
- [サービス境界とデータ配置](service-boundaries.md)
- [開発・デモ環境の起動と停止](../guides/environment-lifecycle.md)
- [要件定義書](../requirements/snow_safe_route_requirements.md)
