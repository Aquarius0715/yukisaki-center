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
- Session Manager接続・DB確認用EC2踏み台（Free Tier対象の`t4g.micro`、受信ルールなし、必要時だけ起動）
- S3 Gateway Endpoint、1 AZのSecrets Manager Interface Endpoint
- Secrets Manager自動生成DB認証情報
- デフォルト無効のWeather用EventBridge Rule
- Weather Schedule DLQ、Processing DLQ、CloudWatch Alarm/Dashboard/Logs

旧JMA Atom Collector、旧Normalizer、固定fixture Collector、旧EventBridge Schedulerは2026-07-14のスタック更新で削除済み。現在はEventBridge Ruleを共通の収集入口として再導入し、デプロイ直後は無効にする。S3は正本なので維持する。

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
- 2026-07-14に気象・道路収集スタックを再デプロイし、両CloudFormationスタックの`UPDATE_COMPLETE`を確認済み
- Weather・道路のEventBridge Ruleはいずれも`DISABLED`、実行中の道路ECSタスクは0件
- Weather Schedule DLQ・Road Schedule DLQはいずれも0件
- 2026-07-15にFree Tier対象`t4g.micro`のSSM踏み台を再構築し、踏み台内の`yukisaki-psql`から7件を直接SELECTできることを確認済み
- 旧踏み台とローカルのDBポートフォワーディング／Docker版`psql`環境は削除済み
- 接続検証後は踏み台を停止済み。RDSは非公開、踏み台Security Groupにも受信ルールはない
- 2026-07-21にコミット`25e5f07`を気象・道路・消雪パイプの3スタックへデプロイし、全スタック`UPDATE_COMPLETE`とCDK差分0を確認済み
- 旧道路S3通知カスタムリソース、通知用Lambda・IAM、旧道路ECSタスク定義、旧踏み台EC2はCloudFormationで削除済み。気象S3通知用のCloudFormation管理Lambdaは現行構成に必要なため維持する
- `env:start|stop|status`でRDS、3つのEventBridge Rule、関連Lambda、道路Fargateを一括管理し、SSM踏み台はDB確認時だけ起動する

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
| `weatherScheduleEnabled` | `false` |
| `weatherScheduleHours` | `24` |
| `roadScheduleEnabled` | `false` |
| `roadScheduleHours` | `168` |

## デプロイ

認証を確認する。

```bash
cd infrastructure/cdk
npm run aws -- sts get-caller-identity --profile yukisaki-dev --region ap-northeast-1
```

差分には気象用のEventBridge RuleとDLQ、道路用の独立スタックが含まれる。両Ruleの初期状態が`DISABLED`であることを`cdk diff`で確認する。

```bash
npx cdk diff --profile yukisaki-dev
npx cdk deploy --profile yukisaki-dev --require-approval never
```

RDS作成には数分以上かかる。出力からCollector/Loader名とS3バケット名を取得する。

## データ投入

CollectorはEventBridge Ruleから起動できるが、固定デモデータを重複取得しないよう初期状態は無効である。必要な1回だけ実行するときはLambdaを手動実行する。

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
