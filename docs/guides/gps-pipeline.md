# 除雪車GPS仮データ・走りやすさ指数パイプライン

## 概要

2026年1月23日12:00 JSTの長岡市石動南町をシナリオ開始時刻とし、3台の仮想除雪車を既存道路上で走らせる。実在車両・実際の除雪状況ではなく、全データに`is_simulated: true`を保持する。

```text
GPS Simulator ECS Fargate（1タスク・3台・5秒間隔）
  -> Kinesis Data Streams（vehicle_idでpartition）
     +-> Raw Archiver Lambda -> S3 raw/simulated/plow-gps/
     +-> Map Matcher Lambda
          -> S3 normalized/simulated/plow-gps/
          -> S3 curated/snowplow-passages/
          -> SQS
             +-> private GPS DB Loader -> PostgreSQL
             +-> 60秒遅延 -> private Drivability Scorer
                    -> S3 curated/drivability-scores/
                    -> PostgreSQL
```

S3が正本であり、PostgreSQLは再作成可能な投影である。GPS送信元、収集、前処理、DBロード、指数計算を直接呼び出しで結合しない。

## サービス責務

| 場所 | 責務 |
|---|---|
| `services/gps-simulator/` | curated道路から周回経路を作り、3台のGPSイベントをKinesisへ送信 |
| `data-ingestion/plow_gps/` | Kinesisイベントを検証してS3 rawへ不変保存 |
| `data-processing/plow_gps/` | 道路マッチング、normalized/curated保存、PostgreSQLロード |
| `drivability-scoring/` | 気象・道路・消雪パイプ・最終除雪時刻から決定的に指数計算 |

## PostgreSQL

```text
snowplow_vehicles             車両マスタ（3台）
snowplow_positions_latest     地図表示用の最新位置
snowplow_segment_passages     道路区間ごとのGPS通過履歴
drivability_scores            時刻・ルール版ごとの指数と根拠
```

## 起動・停止

GPS Simulatorはデプロイ時`desiredCount=0`、4つのLambdaは予約同時実行数0である。デプロイだけではGPSを送らない。

```bash
cd infrastructure/cdk
npm run env:start -- --profile yukisaki-dev
npm run env:status -- --profile yukisaki-dev
npm run env:stop -- --profile yukisaki-dev
```

`env:start`は共通RDSが利用可能になってからLambdaを再開し、GPS Simulatorを`desiredCount=1`にする。`env:stop`はSimulatorを0、Lambdaを0、RDSを停止する。Kinesis Stream、S3、SQS、DLQ、ログは正本・再試行のため維持する。

## 確認SQL

```sql
SELECT vehicle_id, observed_at, latitude, longitude,
       speed_kmh, operation, matched_segment_id
FROM snowplow_positions_latest
ORDER BY vehicle_id;

SELECT segment_id, max(observed_at) AS last_plowed_at, count(*) AS gps_points
FROM snowplow_segment_passages
GROUP BY segment_id
ORDER BY last_plowed_at DESC
LIMIT 20;

SELECT DISTINCT ON (segment_id)
       segment_id, data_timestamp, score, confidence, factors, rule_version
FROM drivability_scores
ORDER BY segment_id, data_timestamp DESC;
```

## 制約

- MVPのマップマッチングは全道路LineStringへの最近傍距離で決定する。
- `ground_truth_segment_id`はモック内部の正解、`matched_segment_id`は前処理結果であり混同しない。
- Kinesisは停止中もStream時間料金が発生する。Fargate、RDS、Lambda実行は`env:stop`で停止する。
- 指数はルールベースでのみ決定し、LLMは関与しない。
