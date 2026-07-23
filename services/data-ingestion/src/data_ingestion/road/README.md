# 雪対応ナビゲーション用道路データ生成

新潟県長岡市のOSM行政界ポリゴン内にある、自動車通行可能な道路（`network_type="drive"`）を取得し、積雪管理用の約25m区間GeoJSONへ変換します。歩道・自転車道・階段などはOSMnxのdriveネットワークから除外されます。上位データパイプラインのS3バケットへ不変保存します。

## 構成

`src/fetch_osm.py` は取得、`segment_roads.py` は重複整理と分割、`export_geojson.py` は一時ファイル作成、`upload_s3.py` はS3、`config.py` は設定、`main.py` はCLIを担当します。S3には地図描画用の`road_segments.geojson`、分析用の`road_attributes.csv`、メタデータを保存します。耐久保存先はS3であり、`road/output/` は作成しません。必要な場合だけ `--output`、`--attributes-output`、`--metadata-output`でローカル出力先を明示できます。

## セットアップと実行

```bash
cd road
python -m venv .venv
```

Windows:

```powershell
.venv\Scripts\activate
```

macOS/Linux:

```bash
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m src.main --skip-upload
pytest
```

CLIは `--place-name`、`--segment-length`、`--fallback-center-lat`、`--fallback-center-lon`、`--radius`、`--output`、`--attributes-output`、`--metadata-output`、`--aws-profile`、`--s3-bucket`、`--skip-upload`、`--log-level` を受けます。CLI値は環境変数より優先されます。

地名ポリゴンの取得を必須とし、AWSでは`OSM_PLACE_NAME=新潟県長岡市`を指定します。行政界取得に失敗した場合は狭い範囲へ黙って縮退せず、収集全体を失敗させます。ローカルで明示的に`FALLBACK_CENTER_LAT/LON`を設定した場合だけ点・半径方式へフォールバックできます。

## 分割と重複整理

投影CRS（GeoPandasのUTM推定）で道路長を測ります。長さ `L` に対し `floor(L/T)` と `ceil(L/T)` のうち `L/N` が目標 `T`（既定25m）に近い方を採用し、同じ長さのLineStringへ切り出します。同率では多い分割数です。出力直前にEPSG:4326へ戻します。

双方向の重複は、**一方通行でない**エッジに限り、OSM ID、名前、道路種別、access/service、始終点ノード（順不同）、方向を無視した丸め済み形状が全て一致するときだけ1件にします。一方通行・形状や属性が異なる道路は統合しません。

GeoJSONの主要属性は `segment_id`、`source_edge_id`、`osm_id`、`segment_index`、`segment_count`、`length_m`、開始/終了緯経度、`road_name`（元の`name`も保持）、`highway`、`oneway`、`maxspeed`、`access`、`service`、`snow_depth_cm`、`snow_level`、`snow_updated_at` です。IDはOSM情報と丸め済み座標からSHA-256で決定的に生成します。

## S3

`.env.example` を `.env` に複製し、必要なら `ROAD_S3_BUCKET_NAME`（またはサービス共通の`DATA_BUCKET`）、`ROAD_S3_DATASET`、`UPLOAD_TO_S3=true` を設定します。ローカルでは`AWS_PROFILE`、FargateではタスクIAMロールを使用します。S3出力は上位サービス契約に従い、`raw/osm/{dataset}/ingest_date={date}/run_id={run_id}/` にGeoJSON・CSV・metadata、`manifests/data-ingestion/{run_id}.json` にmanifestを不変保存します。

OSM属性として、道路名・種別・一方通行・制限速度に加え、`lanes`、`lanes:forward`、`lanes:backward`、路面種別、幅員、照明、歩道/自転車道、橋、トンネル、交差点、駐車、路線番号を可能な限りGeoJSONへ保持します。OSMに値がない場合は`null`です。

```bash
aws sts get-caller-identity --profile snow-nav
aws s3 ls s3://{DATA_BUCKET}/raw/osm/road-network/ --profile snow-nav
```

認証情報不足時はAWSアクセスキーの入力を求めず、AWS CLIプロファイル、IAMロール、または `--skip-upload` を案内します。よくある失敗は、地名検索失敗（フォールバック座標を設定）、道路0件（対象地域/半径を確認）、S3権限不足（バケット・IAMポリシーを確認）です。
