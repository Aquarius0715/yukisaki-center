# データ収集・前処理の実装・デプロイ

## 1. 実装済みの範囲

現在のリポジトリには、気象庁Atomフィードを定期収集してS3へ保存し、フィード項目をJSON Linesへ正規化するAWS基盤が実装されている。

```text
EventBridge Scheduler
  -> data-ingestion (Lambdaコンテナ)
  -> S3 raw/jma/weather-feed/
  -> S3 ObjectCreated
  -> data-processing (Lambdaコンテナ)
  -> S3 normalized/jma-weather-feed/

失敗
  -> SQS DLQ
  -> CloudWatch Alarm / Dashboard
```

CDKが作成するリソースは次のとおり。

- 非公開、暗号化、バージョニング済みS3バケット
- 気象CollectorのLambdaコンテナ
- 気象NormalizerのLambdaコンテナ
- 1時間ごとのEventBridge Scheduler
- Scheduler用と非同期処理用のSQS DLQ
- LambdaエラーとDLQメッセージのCloudWatch Alarm
- Lambdaエラー、処理時間、DLQを表示するCloudWatch Dashboard
- サービスごとにS3プレフィックスを制限したIAMロール
- 30日保持のCloudWatch Logs

## 2. ディレクトリ構成

```text
infrastructure/
  cdk/
    package.json
    package-lock.json
    cdk.json
    tsconfig.json
    jest.config.js
    bin/app.ts                   CDKエントリーポイント
    lib/data-pipeline-stack.ts   AWSリソース定義
    test/data-pipeline-stack.test.ts
    scripts/aws-docker.sh        Docker版AWS CLIラッパー
  compose/docker-compose.yml     サービス単体テスト
services/
  data-ingestion/                気象収集Lambdaコンテナ
  data-processing/               気象正規化LambdaとPostgreSQLローダー
  drivability-scoring/           今後の指数計算サービス
  route-planning/                今後の経路探索サービス
  ai-assistant/                  今後の自然言語・説明サービス
  api/                           今後のREST APIサービス
  web/                           今後のWebフロントエンド
```

各サービスは`services/<分類>/<サービス名>/`だけでDockerイメージをビルドできる。Dockerfileは次の2ステージを持つ。

- `test`: Python 3.13上で単体テストを実行する。
- `runtime`: AWS Lambda Python 3.13ベースイメージを使用する。

## 3. 前提環境

- Docker Desktopまたは互換Docker Engine
- Node.js 22 LTSまたは24以降を推奨
- npm
- AWS認証済みプロファイル
- デプロイ先アカウントでCDK bootstrapを実行できる権限

AWS CLIは認証確認や手動実行に使用する。CDK自身もAWS認証情報を必要とする。

ホストのAWS CLIが利用できない場合は、公式AWS CLI Dockerイメージを呼び出す`npm run aws -- <command>`を使用できる。認証キャッシュは標準の`~/.aws`へ保存される。

## 4. ローカル検証

以下のコマンドはすべて`infrastructure/cdk/`で実行する。

```bash
cd infrastructure/cdk
```

依存関係をインストールする。

```bash
npm install
```

Dockerで全サービスをテストする。

```bash
npm run test:services
```

CDKコードを型検査し、テンプレートテストを行う。

```bash
npm run build
npm run test:infra
```

本番LambdaイメージをDockerでビルドし、CloudFormationテンプレートを生成する。

```bash
npm run synth
```

すべてをまとめて検証する場合は次を実行する。

```bash
npm test
npm run synth
```

## 5. 設定

`cdk.json`のcontextで設定する。

| 設定 | 初期値 | 説明 |
|---|---|---|
| `environment` | `dev` | スタック名とタグに使用 |
| `region` | `ap-northeast-1` | デプロイ先リージョン |
| `scheduleMinutes` | `60` | 気象フィード取得間隔 |
| `weatherSourceUrl` | 気象庁regular feed | HTTPS取得元 |

一時的に上書きする場合はCDK contextを使用する。

```bash
npx cdk synth \
  -c environment=dev \
  -c region=ap-northeast-1 \
  -c scheduleMinutes=60
```

`weatherSourceUrl`のホストはLambdaの許可リストへ自動設定される。HTTP URLやユーザー情報を含むURLは拒否される。

新規AWSアカウントではLambdaのアカウント同時実行数が小さい場合があるため、MVPでは関数ごとの予約同時実行数を設定しない。CollectorはEventBridge Schedulerで1時間ごとに起動し、通常のLambda同時実行上限の範囲で実行される。

## 6. AWSデプロイ

### 6.1 認証確認

個人のAWSアカウントでコンソール認証を使う場合は、先に一時認証プロファイルを作成する。

```bash
npm run aws -- login \
  --remote \
  --profile yukisaki-dev \
  --region ap-northeast-1
```

表示されたURLをブラウザで開き、認証コードはチャットやファイルへ保存せず、同じターミナルへ直接入力する。

```bash
npm run aws -- sts get-caller-identity --profile yukisaki-dev
```

表示された`Account`がデプロイ対象であることを確認する。

### 6.2 CDK bootstrap

アカウント・リージョンごとに初回だけ実行する。

```bash
npx cdk bootstrap aws://ACCOUNT_ID/ap-northeast-1 --profile YOUR_PROFILE
```

bootstrapはLambdaコンテナイメージを保存するECRリポジトリ等を作成する。

### 6.3 差分確認

```bash
npx cdk diff --profile YOUR_PROFILE
```

S3バケット、Lambda、Scheduler、SQS、CloudWatch、IAM以外に意図しない変更がないことを確認する。

### 6.4 デプロイ

```bash
npx cdk deploy --profile YOUR_PROFILE
```

デプロイ後に次のOutputを控える。

- `DataBucketName`
- `CollectorFunctionName`
- `NormalizerFunctionName`
- `SchedulerDlqUrl`
- `ProcessingDlqUrl`

## 7. デプロイ後の疎通確認

Collectorを手動実行する。

```bash
npm run aws -- lambda invoke \
  --region ap-northeast-1 \
  --function-name COLLECTOR_FUNCTION_NAME \
  --payload '{"dataset":"jma-weather-feed","executionId":"manual-smoke-test"}' \
  --cli-binary-format raw-in-base64-out \
  --profile YOUR_PROFILE \
  /tmp/collector-response.json
```

S3成果物を確認する。

```bash
npm run aws -- s3 ls s3://DATA_BUCKET_NAME/raw/jma/weather-feed/ --recursive --region ap-northeast-1 --profile YOUR_PROFILE
npm run aws -- s3 ls s3://DATA_BUCKET_NAME/normalized/jma-weather-feed/ --recursive --region ap-northeast-1 --profile YOUR_PROFILE
npm run aws -- s3 ls s3://DATA_BUCKET_NAME/manifests/ --recursive --region ap-northeast-1 --profile YOUR_PROFILE
```

期待する成果物:

```text
raw/jma/weather-feed/ingest_date=.../run_id=.../response.xml
raw/jma/weather-feed/ingest_date=.../run_id=.../metadata.json
normalized/jma-weather-feed/event_date=.../run_id=.../part-00000.jsonl
manifests/data-ingestion/....json
manifests/data-processing/....json
```

## 8. 現在の処理境界

Normalizerが作るのは、気象庁Atomフィードに掲載された電文の索引である。気温、降雪量、積雪深等の実数値はまだ正規化しない。

次の実装単位は、道路・GPSを含むデモfixtureをS3へ投入し、道路区間単位の`curated/`を生成する処理である。サービスの実装順は[サービス実装の順序](../service-implementation.md)を参照する。

道路・標高処理はデータ量とネイティブ依存が大きいため、Lambdaへ追加せず、同じS3バケットを使用するECS Fargateタスクとして実装する。
