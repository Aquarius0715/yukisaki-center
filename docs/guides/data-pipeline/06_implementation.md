# 気象7時間窓のAWS実装・デプロイ

## 実装範囲

デモ基準時刻を`2026-01-23T12:00:00+09:00`、地点を長岡市石動南町（37.442762, 138.790865）に固定する。

```text
Open-Meteo Historical Weather API（09:00〜12:00の実気象）
Open-Meteo Historical Forecast API（13:00〜15:00の当時予報）
                         |
                         v
WeatherWindowCollector Lambda
                         |
                         v
S3 raw/open-meteo/weather-window/       正本
                         |
                         v
WeatherWindowLoader Lambda (private VPC)
          |                              |
          v                              v
S3 normalized/...jsonl       RDS PostgreSQL weather_hourly_windows
```

AWSリソースは次のとおり。

- 非公開・暗号化・バージョニング済みS3バケット1個
- VPC外の収集Lambda 1個
- private subnet内の処理・DBロードLambda 1個
- 非公開・暗号化・Single-AZのRDS PostgreSQL 16（`db.t4g.micro`）
- S3 Gateway Endpoint、1 AZのSecrets Manager Interface Endpoint
- Secrets Manager自動生成DB認証情報
- SQS DLQ、CloudWatch Alarm/Dashboard/Logs

旧JMA Atom Collector、旧Normalizer、固定fixture Collector、EventBridge Scheduler、Scheduler DLQは2026-07-14のスタック更新で削除済み。S3は正本なので維持する。

## AWS反映状況

2026-07-14にAWSアカウント`179260492296`、東京リージョンへデプロイし、次を確認済み。

- Collector実行成功
- S3 rawに`response.json`と`metadata.json`を保存
- S3 normalizedに`part-00000.jsonl`を保存
- RDS PostgreSQLに09:00〜15:00 JSTの7件を保存
- 内訳は実気象4件、当時予報3件
- Processing DLQは0件
- 旧Lambda 3個とEventBridge Schedulerは存在しない
- 2026-07-14にSecrets Manager Endpointを1 AZ化し、RDSの7件が維持されることを再確認済み

## ローカル検証

```bash
cd infrastructure/cdk
npm run test:services
npm run test:infra
npm run build
npm run synth
```

## 設定

`infrastructure/cdk/cdk.json`のcontextを使用する。

| 設定 | 値 |
|---|---|
| `environment` | `dev` |
| `region` | `ap-northeast-1` |
| `targetReferenceTime` | `2026-01-23T12:00:00+09:00` |
| `targetLatitude` | `37.442762` |
| `targetLongitude` | `138.790865` |

## デプロイ

認証を確認する。

```bash
cd infrastructure/cdk
npm run aws -- sts get-caller-identity --profile yukisaki-dev --region ap-northeast-1
```

差分にはRDS/VPC/Lambda 2個の作成と、旧Lambda 3個・Scheduler等の削除が含まれる。

```bash
npx cdk diff --profile yukisaki-dev
npx cdk deploy --profile yukisaki-dev --require-approval never
```

RDS作成には数分以上かかる。出力からCollector/Loader名とS3バケット名を取得する。

## データ投入

Collectorを手動実行する。

```bash
npm run aws -- lambda invoke \
  --function-name COLLECTOR_FUNCTION_NAME \
  --payload '{"executionId":"weather-20260123-1200"}' \
  --cli-binary-format raw-in-base64-out \
  --region ap-northeast-1 \
  --profile yukisaki-dev \
  /dev/stdout
```

S3イベントでLoaderが自動起動し、7件をDBへUPSERTする。S3を確認する。

```bash
npm run aws -- s3 ls s3://DATA_BUCKET_NAME/raw/open-meteo/weather-window/ --recursive --region ap-northeast-1 --profile yukisaki-dev
npm run aws -- s3 ls s3://DATA_BUCKET_NAME/normalized/open-meteo/weather-window/ --recursive --region ap-northeast-1 --profile yukisaki-dev
```

LoaderのDB確認アクションで7件を確認する。

```bash
npm run aws -- lambda invoke \
  --function-name LOADER_FUNCTION_NAME \
  --payload '{"action":"status"}' \
  --cli-binary-format raw-in-base64-out \
  --region ap-northeast-1 \
  --profile yukisaki-dev \
  /dev/stdout
```

結果の`recordCount`が7で、`relativeHour`が`-3`〜`3`、`dataKind`が`observed` 4件と`forecast` 3件であることを確認する。

`npm run aws`はDockerコンテナ内でAWS CLIを動かすため、ホスト側の`/tmp`へ結果ファイルは残らない。応答を確認するときは出力先に`/dev/stdout`を指定する。

## コストと削除

RDSとSecrets Manager Interface Endpointは起動時間に応じて料金が発生する。開発・デモ環境の起動と停止には`npm run env:start`、`npm run env:stop`、`npm run env:status`を使う。詳しくは[開発・デモ環境の起動と停止](../environment-lifecycle.md)を参照する。

RDSは開発用として削除保護を無効、最終スナップショットなしに設定している。S3は正本なので、単純な`cdk destroy`で実行系と一緒に扱わず、長期休止用のスタック分割後に実行系だけを削除する。
