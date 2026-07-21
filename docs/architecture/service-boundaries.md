# サービス境界とデータ配置

## 正本の原則

気象、道路、標高、消雪設備、除雪車GPSの全てについて、最初にS3 `raw/`へ原本を保存する。S3の`raw/`、`normalized/`、`curated/`が履歴と再処理の正本である。PostgreSQLはAPI・地図・経路探索を高速化するための再作成可能な配信用投影であり、正本ではない。

```text
公開データ / fixture
       |
       v
 data-ingestion ----> S3 raw
                         |
                         v
                 data-processing
                         |
                         +--> S3 normalized / curated (正本)
                         |
                         v
                   PostgreSQL + PostGIS + pgRouting (派生)
                     |                 |
                     v                 v
          drivability-scoring     route-planning
                     |                 |
                     +--------> REST API <-------- ai-assistant
                                      |
                                      v
                                     web
```

## サービス間契約

| 送信元 | 受信先 | 契約 |
|---|---|---|
| data-ingestion | data-processing | S3 `raw/`オブジェクト、メタデータ、`run_id` |
| data-processing | PostgreSQL | `curated/`の検証済みスナップショット。ロード元S3キーを記録する |
| drivability-scoring | PostgreSQL / API | `segment_id`、時刻、score、confidence、根拠、rule version |
| route-planning | API | GeoJSON経路、コスト、使用時刻、指数版 |
| ai-assistant | API | 構造化した利用者条件と説明用の根拠データ |
| API | web | JSON/GeoJSON。時刻・信頼度・シミュレーションフラグを含む |

各サービスの内部は`src/`、`tests/`、`config/`、`docs/`、`AGENTS.md`へ分離する。サービス固有のAI指示は全体の[AGENTS.md](../../AGENTS.md)を補完するものであり、全体方針と矛盾させない。

## 道路・消雪パイプのイベント駆動処理

```text
Road Collector Fargate
  -> S3 manifests/data-ingestion/{run_id}.json
  -> CloudTrail S3 data event -> EventBridge
  -> Step Functions
       -> Snow Pipe Generator Lambda
       -> Road/Snow Pipe Merger Lambda
       -> S3 curated
       -> SQS
  -> private PostgreSQL Loader Lambda
  -> Snow Pipe専用RDS PostgreSQL (`yukisaki_map`)
```

Snow PipeスタックのCloudTrail data eventは、既存道路スタックや道路S3の通知設定を変更せず、道路バケットの`manifests/data-ingestion/`への書込みだけをEventBridgeへ渡す。道路GeoJSONは道路バケットから読み取り、消雪パイプ仮データ、統合GeoJSON、各manifestはSnow Pipe専用データバケットへ保存する。CloudTrailログ用バケットはデータバケットとは別に管理する。生成・統合LambdaはVPC外、DB LoaderだけをSnow Pipe専用VPCのprivate subnetへ置く。専用RDSは気象RDSと共有しない。RDS停止中はSQSがロード要求を保持するため、S3正本の生成とDB稼働状態を分離できる。

## デモの固定入力

デモは2026年1月23日の新潟県長岡市石動南町を対象にする。各サービスは当日の固定スナップショット／fixtureを参照し、現在値で上書きしない。全レコードに対象時刻、地域、出典、作成・取得時刻、`is_simulated`を保持する。
