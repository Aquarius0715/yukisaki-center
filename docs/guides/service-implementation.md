# サービス実装の順序

## 1. 先に完成させる縦切り

1. `data-ingestion`でデモ用の気象・道路・GPS fixtureをS3 `raw/`へ投入する。
2. `data-processing`で各データを検証し、`normalized/`と道路区間単位の`curated/`へ出力する。
3. `curated/`をPostgreSQLへロードし、ロード元S3キーと`run_id`を記録する。
4. `drivability-scoring`で固定入力から指数を出力する。
5. `route-planning`、REST API、Webの順に配信経路を接続する。
6. 最後に`ai-assistant`をAPIの根拠データだけに接続する。

## 2. ローカル検証

```bash
cd infrastructure/cdk
npm run test:services
npm run test:infra
npm run build
npm run synth
```

PostgreSQLのローカル起動:

```bash
docker compose -f infrastructure/compose/docker-compose.yml up postgres
```

ローカル接続文字列は`postgresql://yukisaki:yukisaki-local-only@localhost:5432/yukisaki`である。これは開発専用であり、AWSではSecrets Managerで管理する。

すべてのサービスはDockerの`test`ターゲットを持つ。実装、テスト、設定、サービス固有資料、AIへの指示を混在させず、それぞれ`src/`、`tests/`、`config/`、`docs/`、`AGENTS.md`へ配置する。

## 3. AWS実装順

現在AWSへデプロイ済みなのは、S3、気象収集Lambda、気象正規化Lambda、Scheduler、DLQ、監視である。RDS、ECS、API、Web、LLM基盤はまだデプロイしない。

次のAWS変更は、`curated/`の道路・デモfixtureが完成してから行う。

1. private subnet内にRDS PostgreSQL（PostGIS / pgRouting対応版）を作成する。
2. `data-processing`をECS Fargateとして実行し、S3からRDSへロードする。
3. 指数・経路サービス、API、Webを段階的に追加する。

各段階で`run_id`からrawまで追跡でき、PostgreSQLを空にしてもS3から復元できることをテストする。
