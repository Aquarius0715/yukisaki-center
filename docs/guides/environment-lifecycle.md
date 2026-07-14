# 開発・デモ環境の起動と停止

## 方針

AWSリソースを次の3種類に分ける。

| 種類 | 扱い | 現在の例 |
|---|---|---|
| `persistent` | 開発停止中も維持 | S3原本、DLQ、ECR、ログ |
| `runtime` | 開発・デモ時だけ起動 | RDS、DBへ接続する処理 |
| `on-demand` | リクエスト時だけ実行 | Collector Lambda、将来のAPI Lambda |

S3を正本とし、PostgreSQLなどの`runtime`はS3から再構築できる状態を保つ。データを守るため、停止操作でS3を削除しない。

Weatherと道路のEventBridge RuleはCDKデプロイ直後はどちらも`DISABLED`である。リソースをデプロイしただけでは定期収集を開始しない。

## 現在の操作

最新のCDKをデプロイした後、`infrastructure/cdk/`で実行する。

```bash
# 状態確認
npm run env:status -- --profile yukisaki-dev

# 開発を終了する
npm run env:stop -- --profile yukisaki-dev

# 開発またはデモを再開する
npm run env:start -- --profile yukisaki-dev
```

`env:stop`は次を行う。

1. Weatherと道路のEventBridge Ruleを無効化する。
2. CollectorとLoader Lambdaの予約同時実行数を0にして、新しい処理を受け付けない。
3. RDS PostgreSQLへ停止を要求する。
4. S3、ECR、Secrets Manager、DLQ、ログは維持する。

`env:start`はRDSを起動して利用可能になるまで待ち、その後にLambdaと両方のEventBridge Ruleを有効化する。RDSの起動には数分以上かかる場合があるため、デモ直前ではなく余裕を持って実行する。

CDKのデプロイやデータ投入を行う前にも`env:start`を実行する。停止中にS3の対象プレフィックスへ新しい原本を置くと処理されないため、手動アップロードを行わない。

## コスト上の注意

- RDS停止中はインスタンス時間料金が止まるが、gp3ストレージ料金は残る。
- Secrets Manager Interface Endpointは停止できない。CDKでは2 AZから1 AZへ減らして固定費を半減する。
- 現在の`env:stop`ではEndpointを残すため、再開は速いが完全なゼロコストにはならない。
- RDSは7日間停止するとAWSにより自動起動される。長期間利用しない場合は、状態を確認して再停止する。
- 将来はS3の永続スタックと実行系スタックを分割し、長期休止時に実行系だけ削除できるようにする。

## 全サービスの停止方針

| サービス | AWS実行方式の基本方針 | 開発停止時 |
|---|---|---|
| `data-ingestion` | EventBridgeからLambdaまたはFargateを起動 | Rule無効、Lambda同時実行数0、Fargateタスク0 |
| `data-processing` | Lambda、RDS | Lambda停止、RDS停止 |
| `drivability-scoring` | Lambdaまたは一時ECSタスク | Lambda停止、ECSタスク0 |
| `route-planning` | LambdaまたはECS Service | Lambda停止、ECS desired count 0 |
| `ai-assistant` | Lambda、外部LLM API | Lambda停止。APIは呼ばなければ課金なし |
| `api` | API Gateway + Lambdaを優先 | Lambda停止。API Gatewayはリクエスト課金 |
| `web` | S3 + CloudFrontの静的配信を優先 | 原則維持。アクセスがなければ課金は小さい |

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

停止は逆順で行う。デモ前には`env:status`、RDSの7件、DLQ 0件、CloudWatch Alarmを確認する。

## 今後サービスを追加するとき

- CDKリソースへ`Service`タグと`Lifecycle`タグを付ける。
- 時間課金リソースには起動・停止または作成・削除手順を用意する。
- `environment.sh`へサービス固有の起動・停止処理を追加する。
- 停止状態からのデモ復旧をテストしてからサービスを完成扱いにする。
