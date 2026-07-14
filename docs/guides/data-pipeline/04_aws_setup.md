# AWS構築手順

## 1. 構築方針

AWSコンソールで一度だけ試すことはできるが、再現可能にするため最終的にはAWS CDK、Terraform、またはCloudFormationのどれか1つで管理する。MVPで採用するIaCを途中で混在させない。

推奨リージョンは、利用可能サービス、レイテンシ、チームの運用場所を確認して1つに固定する。リージョン名やAWSアカウントIDをソースへ直接埋め込まず、環境設定で渡す。

## 2. 構築順序

### Step 1: AWSアカウントの安全設定

- rootユーザーへMFAを設定する。
- 開発者はIAM Identity Center等を使用し、長期アクセスキーを極力発行しない。
- AWS Budgetsで月額予算と通知を設定する。
- リソースに`Project`、`Environment`、`Owner`タグを付ける。
- CloudTrailの有効状態を確認する。

### Step 2: S3データバケット

1. 環境別のデータバケットを作る。
2. Block Public Accessを有効にする。
3. バージョニングを有効にする。
4. デフォルト暗号化を有効にする。
5. `raw`、`normalized`、`curated`、`quarantine`、`manifests`のプレフィックスを使用する。
6. 不完全なマルチパートアップロードを削除するLifecycleを設定する。
7. rawの保持期間はデモ・監査・再処理要件を決めてから設定する。

### Step 3: ログと失敗イベント

- CloudWatch Logsのロググループを処理単位で用意する。
- ログ保持期間を明示する。
- EventBridge RuleのターゲットごとにSQS DLQを作る。
- DLQメッセージ数にCloudWatch Alarmを設定する。
- SNS等でチームへ通知する。通知先の追加は運用責任者の承認を得る。

### Step 4: IAMロール

少なくとも次を分ける。

| ロール | 最小権限 |
|---|---|
| EventBridge実行ロール | 対象Lambda InvokeまたはECS RunTask |
| Weather Collector | rawの対象プレフィックスへのPut、manifest Put、ログ出力 |
| Normalizer | 対象raw Get、normalized/quarantine Put、ログ出力 |
| Batch Task | ECR Pull、対象S3 Get/Put、ログ出力、必要時のみDB接続情報取得 |
| DB Loader | curated Get、DBシークレットGet、ログ出力 |

バケット全体の`*`権限ではなく、可能ならデータセットのプレフィックスまで絞る。

### Step 5: 気象Collector Lambda

1. HTTPクライアント、タイムアウト、再試行、raw保存を実装する。
2. 環境変数にはバケット名、データセット名、タイムアウト等の非秘密値だけを置く。
3. 外部APIキーがある場合はSecrets Managerから取得する。
4. 予約済み同時実行数を小さく設定し、外部提供元への過負荷を防ぐ。
5. 手動テストイベントでrawとmanifestが作られることを確認する。
6. 同一イベントを2回実行し、後段の重複がないことを確認する。

### Step 6: EventBridge Rule

Weatherと道路の収集入口をEventBridge Ruleへ統一する。デプロイ直後は両Ruleを`DISABLED`とし、リソースを配置しただけでは外部取得を開始しない。

- Weatherは`weatherScheduleHours`、道路は`roadScheduleHours`で周期を設定する。
- `weatherScheduleEnabled`と`roadScheduleEnabled`の既定値は`false`にする。
- 再試行回数とイベント保持時間を設定する。
- SQS DLQを設定する。
- payloadへ`dataset`とスケジュール版を含める。`run_id`はオーケストレーターで発行するか、未指定ならCollectorで発行する。

開発・デモ開始時は`npm run env:start`、終了時は`npm run env:stop`で両Ruleをまとめて切り替える。

### Step 7: ECRとFargateバッチ

OSM・標高・PostGISロード用のコンテナをECRへ登録する。道路収集は独立した`YukisakiRoadCollector-*`スタックの`RoadTaskDefinition`として実装済みで、道路専用バケットの`raw/osm/road-network/*`と`manifests/data-ingestion/*`だけに書き込むTask IAM Roleを使用する。インターネット上のOpenStreetMapへアクセスするため、タスクはpublic subnetでpublic IPを持つ。アクセスキーやAWS CLIプロファイルをコンテナイメージ・環境変数へ入れない。

- イメージはバージョンタグだけでなくdigestで実行履歴へ記録する。
- Fargate Task DefinitionへCPU、メモリ、コマンドをデータセット別に定義する。
- Task RoleとTask Execution Roleを分ける。
- 一時ファイル容量を見積もる。
- 終了コードが0でも品質検査が失敗した場合は成功扱いにしない。
- CloudWatch Logsへ`run_id`を含む構造化ログを送る。

道路タスクの周期はCDK contextの`roadScheduleHours`で変更できるが、Ruleは既定で無効である。最初のデプロイ後は、Ruleを有効にする前にECSコンソールまたは`aws ecs run-task`で手動実行し、S3 rawとCloudWatch Logsを確認する。

### Step 8: オーケストレーション

処理が1段ならLambdaから直接実行する。`collect -> normalize -> validate -> publish`の複数段になったらStep Functionsで状態を明示する。

```text
Collect
  -> RawValidate
  -> Normalize
  -> QualityCheck
  -> PublishLatest
  -> NotifySuccess

失敗 -> Quarantine/RecordFailure -> NotifyFailure
```

`PublishLatest`は品質検査成功後だけ実行する。

### Step 9: VPCとRDS

S3 curatedまで完成してから着手する。

1. 2つ以上のAZにprivate subnetを作る。
2. RDS for PostgreSQLをpublic access無効で作る。
3. DB認証情報をSecrets Managerへ置く。
4. Security GroupはDB Loader/ECSから5432だけ許可する。
5. 自動バックアップ期間を設定する。
6. 対応版を確認してPostGIS、pgRoutingを有効化する。
7. スキーママイグレーションを適用する。
8. 固定スナップショットをロードして品質検査する。

RDSのPostgreSQL拡張はバージョン依存である。[AWS公式のPostgreSQL拡張ドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Extensions.html)を確認してからエンジン版を固定する。

## 3. 環境分離

最低でも`dev`と`prod`相当のデモ環境を分ける。費用制約が強い場合は同一AWSアカウントでも、バケット、Scheduler、DBスキーマ、IAMロール、タグを環境別にする。prod相当のrawへ開発処理が書けないIAM境界を作る。

## 4. デプロイ後の確認

1. Collectorを手動起動する。
2. raw本体、metadata、manifestの3点を確認する。
3. Normalizerを固定rawで実行する。
4. 件数、欠測率、スキーマ版を確認する。
5. 同じrunを再実行し、重複しないことを確認する。
6. 意図的に不正データを渡し、quarantineとAlarmを確認する。
7. Schedulerを有効化し、CloudWatch Logsで実行を確認する。
8. DLQへテストイベントを送り、通知経路を確認する。
9. validated snapshotだけが`latest.json`に設定されることを確認する。

## 5. AWSへ載せる前後の切り分け

| ローカルで先に確認 | AWSで確認 |
|---|---|
| パーサーとスキーマ | IAM最小権限 |
| 道路分割とID安定性 | SchedulerとDLQ |
| 標高・勾配計算 | S3暗号化・保持 |
| fixtureによる気象正規化 | 外部接続、タイムアウト、再試行 |
| GPSマップマッチング | CloudWatch監視 |
| 冪等な出力 | ECS/RDSネットワーク |
