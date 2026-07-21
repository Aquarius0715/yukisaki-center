# 収集・前処理アーキテクチャ

## 1. 推奨構成

```text
公開データ / 仮データ
        |
        v
 Collector (LambdaまたはFargate Task)
        |
        v
 S3 raw ------------- 再処理時の入力・監査証跡
        |
        v
 Normalizer / Validator
        |
        v
 S3 normalized ------ 形式を統一した履歴データ
        |
        v
 Geospatial Processor
        |
        v
 S3 curated --------- 道路区間単位のロード可能データ
        |
        v
 RDS PostgreSQL + PostGIS (+ pgRouting)
```

収集処理はEventBridge Ruleを共通の入口とする。単純な気象取得はLambda、OSM展開、道路グラフ生成、大量の標高付与はECS Fargateのバッチタスクに分ける。Ruleはデプロイ時に無効とし、開発・デモ時だけ有効化する。処理時間や依存ライブラリが増えた処理をLambdaへ無理に収めない。

## 2. データゾーン

| ゾーン | 変更可否 | 内容 | 主な形式 |
|---|---|---|---|
| `raw` | 原則不変 | 外部から受け取った原本、HTTPメタデータ | XML、JSON、PBF、CSV |
| `normalized` | 再生成可能 | 名前、型、単位、時刻を統一した履歴 | Parquet、GeoParquet、JSON Lines |
| `curated` | 再生成可能 | `segment_id`単位に結合したDBロード直前データ | GeoParquet、Parquet |
| `quarantine` | 原則不変 | スキーマ違反、範囲外、解析失敗した入力 | 原形式 + エラーJSON |

原本は必ず`raw`へ保存する。外部レスポンスをそのままRDSへ書く設計にはしない。

## 3. S3キー設計

バケットは環境ごとに分け、ゾーンはプレフィックスで分ける。

```text
s3://snow-route-data-{account_id}-{region}/
  raw/{source}/{dataset}/ingest_date=YYYY-MM-DD/run_id={uuid}/...
  normalized/{dataset}/event_date=YYYY-MM-DD/part-....parquet
  curated/{dataset}/snapshot_date=YYYY-MM-DD/part-....parquet
  quarantine/{source}/{dataset}/ingest_date=YYYY-MM-DD/run_id={uuid}/...
  manifests/{pipeline}/{run_id}.json
```

例:

```text
raw/open-meteo/weather-window/event_date=2026-01-23/run_id=.../response.json
raw/osm/road-network/ingest_date=2026-07-12/run_id=.../nagaoka.osm.pbf
normalized/weather-observation/event_date=2026-07-12/part-000.parquet
curated/road-segments/snapshot_date=2026-07-12/part-000.geoparquet
```

`latest.json`を置く場合も、実データは上書きせず、検証済みスナップショットのキーだけを指すポインタにする。

## 4. 共通メタデータ

全データセットに次のメタデータを持たせる。

| 項目 | 説明 |
|---|---|
| `metadata_schema_version` | 共通メタデータ契約の版 |
| `dataset` | データセット名 |
| `source` | `open-meteo`、`openstreetmap`、`gsi`、`mock`等 |
| `source_urls` | 実際に参照した取得元URL配列 |
| `fetched_at` | システムが取得したUTC時刻 |
| `target_start_at` / `target_end_at` | データが対象とする期間 |
| `run_id` | 1回の処理を追跡するUUID |
| `checksum_sha256` | 原本または論理レコードのハッシュ |
| `is_simulated` | 仮データなら`true` |

`fetched_at`と対象日時は意味が異なるため、同じ値として扱わない。実装の正本は`services/data-ingestion/src/data_ingestion/common/metadata.py`である。

## 5. 冪等性

同じデータを複数回取得・処理しても結果が重複しないようにする。

- raw: `run_id`ごとに保存し、`checksum_sha256`で同一原本を判定する。
- normalized: データセットごとの自然キーと`source_version`で一意にする。
- curated: `segment_id + snapshot_at`等で一意にする。
- DB: ステージングテーブルへロードし、制約違反がないことを確認してからUPSERTする。
- 成功した処理だけ`manifests`へ`status: succeeded`を書き、`latest.json`を更新する。

## 6. 道路区間ID

`segment_id`は下流の結合キーなので、処理のたびにランダム採番しない。MVPでは、次の正規化値からハッシュを作る。

```text
segment_id = sha256(
  source + source_way_id + direction +
  source_node_id + target_node_id + geometry_version
)
```

OSM更新で形状や接続点が変わる場合に備え、次も保持する。

- `source_way_id`
- `source_node_id` / `source_target_node_id`
- `geometry_version`
- `valid_from` / `valid_to`
- 旧IDと新IDの対応表

## 7. 実行単位

| 処理 | 初期実行基盤 | 理由 |
|---|---|---|
| 気象XML/JSON取得 | Lambda | 短時間、少量、定期実行 |
| 仮CSV/JSON検証 | Lambda | イベント駆動で処理可能 |
| OSM PBF抽出 | ローカル後にFargate | CPU、メモリ、ネイティブ依存が大きい |
| 道路分割・グラフ生成 | Fargate | 長時間化しやすく再現可能なコンテナ向き |
| 標高タイル取得 | FargateまたはLambda | 対象点数に応じて選択 |
| PostGISロード | Fargate | DB接続、トランザクション、長時間処理 |

## 8. セキュリティとネットワーク

- S3はBlock Public Accessを有効にする。
- 保存時暗号化を有効にする。
- IAMはパイプライン単位のロールとし、対象プレフィックスだけを許可する。
- RDSはprivate subnetへ置き、処理タスクのSecurity Groupだけを許可する。
- DB確認は、受信ルールなしのSSM踏み台を必要時だけ起動し、Session Managerで入って踏み台内の`psql`を使う。踏み台Security GroupからRDSの5432だけを許可する。
- 外部APIの秘密値がある場合はSecrets Managerへ保存する。
- S3やCloudWatchへアクセスするだけのLambdaを、理由なくVPCへ入れない。

## 9. コストを抑える判断

気象・道路・消雪パイプは単一のprivate RDSを使用するため、起動中は料金が発生する。デモ環境を長期間使わない場合は共通RDSを停止し、必要なS3正本を保持する。Weather、道路、消雪パイプmanifestのEventBridge Ruleは既定で無効にし、開発・デモ時だけ`env:start`で有効化する。
