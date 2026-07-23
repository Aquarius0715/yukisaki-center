# 開発・デモ環境の起動と停止

## 方針

AWSリソースを次の3種類に分ける。

| 種類 | 扱い | 現在の例 |
|---|---|---|
| `persistent` | 開発停止中も維持 | S3原本、Web配信S3、EventBridge、SQS、DLQ、ECR、ログ |
| `runtime` | 開発・デモ時だけ起動 | 共通RDS、GPS Simulator、DBへ接続する処理、Web CloudFront配信 |
| `on-demand` | リクエスト時だけ実行 | Collector Lambda、DB確認用SSM踏み台、API Gateway経由のAPI Lambda |

S3を正本とし、PostgreSQLなどの`runtime`はS3から再構築できる状態を保つ。データを守るため、停止操作でS3を削除しない。

Weather、道路、消雪パイプmanifestのEventBridge RuleはCDKデプロイ直後はすべて`DISABLED`である。リソースをデプロイしただけでは収集・連携処理を開始しない。

## AWS CLI認証

ホストへインストールしたAWS CLIではなく、プロジェクトのDocker版CLIを使用する。認証期限切れ時は、ブラウザコールバックを必要としないremoteフローで再認証する。認証情報はホストの`~/.aws`へ保存され、CDKと各運用コマンドで共有される。

```bash
cd infrastructure/cdk
npm run aws -- login --remote --profile yukisaki-dev
npm run aws -- sts get-caller-identity --profile yukisaki-dev
```

## 現在の操作

最新のCDKをデプロイした後、`infrastructure/cdk/`で実行する。

```bash
# 状態確認
npm run env:status -- --profile yukisaki-dev

# 開発を終了する
npm run env:stop -- --profile yukisaki-dev

# 開発またはデモを再開する
npm run env:start -- --profile yukisaki-dev

# Webだけを操作する場合
npm run web:status -- --profile yukisaki-dev
npm run web:enable -- --profile yukisaki-dev
npm run web:disable -- --profile yukisaki-dev
```

Webを初回デプロイするとき、またはMapKit JSトークンを更新するときは、Git管理外の`services/web/env.local`へ`VITE_MAPKIT_TOKEN`を設定し、`npm run web:secret:sync -- --profile yukisaki-dev`を実行する。通常のWebデプロイは`npm run web:deploy -- --profile yukisaki-dev`を使用し、Secrets Managerの`yukisaki/dev/web/mapkit-js-token`からトークンを取得する。

`env:stop`は次を行う。

1. Weather、道路、消雪パイプmanifestのEventBridge Ruleを無効化する。
2. GPS Simulator ECS Serviceを`desiredCount=0`にする。
3. Weather、Snow Pipe、GPS、指数計算、Map API、AI Assistant Lambdaの予約同時実行数を0にする。
4. WebのCloudFront Distributionを無効化する。
5. 実行中の道路Fargateタスクへ停止を要求する。
6. 全サービス共通RDSへ停止を要求する。
7. EventBridge、S3、ECR、Secrets Manager、SQS、DLQ、ログは維持する。

`env:start`は共通RDSを起動して利用可能になるまで待つ。その後に関連Lambda（Map APIとAI Assistantを含む）と3つのEventBridge Ruleを有効化し、GPS Simulatorを1タスク起動してWeb CloudFrontを有効化する。RDS起動とCloudFront設定反映には数分以上かかる場合があるため、デモ直前ではなく余裕を持って実行する。CloudFrontの`status=Deployed`が反映完了を表す。

全道路の走りやすさ指数を初期化・再計算するときは、起動完了後に`npm run score:all -- --profile yukisaki-dev`を実行する。以後はGPS通過区間がSQS経由で差分更新される。

CDKのデプロイやデータ投入を行う前にも`env:start`を実行する。停止中にS3の対象プレフィックスへ新しい原本を置くと処理されないため、手動アップロードを行わない。

DB内容だけをpsqlで確認するときは、定期収集を有効化しない`npm run db:start`でRDSと踏み台をまとめて起動する。確認後は`npm run db:stop`で両方を停止する。接続手順は[SSM踏み台からRDSを確認する](database-access.md)を参照する。

## コスト上の注意

- 共通RDSは停止中にインスタンス時間料金が止まるが、gp3ストレージ料金は残る。
- Secrets Manager Interface Endpointは停止できない。CDKでは2 AZから1 AZへ減らして固定費を半減する。
- 現在の`env:stop`ではEndpointを残すため、再開は速いが完全なゼロコストにはならない。
- Web配信S3は停止時も保持する。CloudFrontは無効化してもDistribution自体の設定は維持される。
- GPS入口はEventBridgeとSQSのリクエスト課金であり、`env:stop`後にStreamの固定時間料金は発生しない。
- RDSは7日間停止するとAWSにより自動起動される。長期間利用しない場合は、状態を確認して再停止する。
- DB確認後は`npm run db:stop`でRDSと踏み台をまとめて停止する。踏み台の停止中も8 GiBのEBS料金は残る。
- 将来はS3の永続スタックと実行系スタックを分割し、長期休止時に実行系だけ削除できるようにする。

## 全サービスの停止方針

| サービス | AWS実行方式の基本方針 | 開発停止時 |
|---|---|---|
| `gps-simulator` | ECS Fargate Service | desired count 0 |
| `data-ingestion` | EventBridgeからLambdaまたはFargateを起動 | Rule無効、Lambda同時実行数0、Fargateタスク0 |
| `data-processing` | Lambda、RDS | Lambda停止、RDS停止 |
| `drivability-scoring` | Lambdaまたは一時ECSタスク | Lambda停止、ECSタスク0 |
| `route-planning` | LambdaまたはECS Service | Lambda停止、ECS desired count 0 |
| `ai-assistant` | Lambda、Amazon Bedrock | Lambda停止。Bedrockは呼ばなければ推論課金なし |
| `api` | API Gateway + Lambdaを優先 | Lambda停止。API Gatewayはリクエスト課金 |
| `web` | 非公開S3 + CloudFront OAC | S3は維持、CloudFront Distributionは無効 |

常駐コンテナが必要になった場合も、開発停止時はECSの`desiredCount=0`にする。OpenSearchやNAT Gatewayのように停止できず時間課金されるサービスは、MVPでは安易に追加せず、必要時だけ作成できる別スタックへ分ける。

## デモ開始順序

```text
RDS起動・接続確認
  -> data-processing
  -> drivability-scoring
  -> route-planning / ai-assistant
  -> REST API
  -> Web
  -> スモークテスト
```

停止は逆順で行う。デモ前には`env:status`、RDSの気象245件、道路・指数の全域版件数、DLQ 0件、CloudWatch Alarmを確認する。

## 今後サービスを追加するとき

- CDKリソースへ`Service`タグと`Lifecycle`タグを付ける。
- 時間課金リソースには起動・停止または作成・削除手順を用意する。
- `environment.sh`へサービス固有の起動・停止処理を追加する。
- 停止状態からのデモ復旧をテストしてからサービスを完成扱いにする。
