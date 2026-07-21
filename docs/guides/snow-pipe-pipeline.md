# 消雪パイプ仮データ処理

## 処理フロー

```text
Road Collector Fargate
  -> S3 manifests/data-ingestion/{road_run_id}.json
  -> CloudTrail S3 data event -> EventBridge
  -> Step Functions Standard
       1. SnowPipeGenerator Lambda
       2. RoadSnowPipeMerger Lambda
       3. RoadDatabaseLoadQueueへ送信
  -> RoadDatabaseLoader Lambda
  -> Snow Pipe専用RDS PostgreSQL (`yukisaki_map`)
```

道路CollectorはGeoJSON、CSV、metadataを保存した後、完了manifestを最後に保存する。Snow Pipeスタック内のCloudTrail data eventは道路バケットの`manifests/data-ingestion/`への書込みだけをEventBridgeへ渡す。既存道路スタックや道路S3の通知設定は変更しない。生成物はSnow Pipeスタックが所有する専用データバケットへ保存し、CloudTrailログ用バケットとは分離する。

## 判定ルール

`road_name`（なければOSMの`name`）がNULL、空文字、空白だけでなければ`snow_pipe=true`とする。これはMVPの仮データ生成規則であり、設備の実在や稼働を示さない。全レコードへ次を保持する。

```text
source=simulated-road-name-rule
rule_version=road-name-v1
operation_status=unknown
is_simulated=true
```

同じ道路`run_id`、ルール版、デモ基準時刻から同じ消雪パイプ`run_id`を生成する。統合・DBロードも決定的な処理IDとUPSERTを使用し、EventBridgeやSQSの再配信で論理的な重複を作らない。

## S3配置

```text
raw/osm/road-network/ingest_date={date}/run_id={road_run_id}/road_segments.geojson
Snow Pipe専用データバケット:
  raw/simulated/snow-pipe/scenario_date=2026-01-23/run_id={snow_run_id}/snow_pipe.jsonl
  curated/road-segments/snapshot_date=2026-01-23/run_id={processing_run_id}/road_segments_enriched.geojson
manifests/data-ingestion/{road_run_id}.json
manifests/data-ingestion/{snow_run_id}.json
manifests/data-processing/{processing_run_id}.json
```

道路GeoJSONと消雪パイプJSONLはS3オブジェクトメタデータのSHA-256を本文から再計算して検証する。既存道路manifestは本文に保持する道路チェックサムを検証する。道路と消雪パイプの`segment_id`集合が一致しない場合はcuratedもDBも更新しない。

## RDS停止時

生成・統合LambdaはVPC外で常時実行可能とし、S3 curatedを先に完成させる。Snow Pipe専用RDS停止中はロード要求を`RoadDatabaseLoadQueue`へ保持する。RDSが利用可能になった後で`RoadDatabaseLoader`の予約済み同時実行数0を解除し、キューを処理する。規定回数失敗した要求はDLQへ移動する。気象RDSは使用しない。

## ローカル検証

```bash
cd infrastructure/cdk
npm test
npm run build
npm run synth
```

Docker Desktopの容量が限られる場合は、先に小さい対象テストを実行する。

```bash
docker compose -f ../compose/docker-compose.yml run --build --rm data-ingestion-test
docker compose -f ../compose/docker-compose.yml run --build --rm data-processing-test
docker compose -f ../compose/docker-compose.yml run --build --rm road-test
```

## デプロイ

AWSへ反映する前に`cdk diff`で既存S3とRDSが置換されないこと、道路収集Scheduleが`DISABLED`のままであることを確認する。

```bash
cd infrastructure/cdk
npm run snow:diff -- --profile yukisaki-dev
npm run snow:deploy -- --profile yukisaki-dev --require-approval never
```

専用コマンドは`YukisakiSnowPipePipeline-dev`だけを合成・更新し、気象・道路スタックをデプロイしない。初回は既存道路manifestをStep Functionsへ渡し、S3 raw/curated、SQS、DLQ、専用RDS件数を順に確認する。確認後はLoaderの予約済み同時実行数を0へ戻し、専用RDSを停止する。
