# yukisaki-center

雪道の走りやすさ可視化・安全経路案内システムのMVPリポジトリ。

## データパイプライン

気象・道路・GPSなどのデータは、まずS3へ不変保存する。S3の`raw/`、`normalized/`、`curated/`を正本とし、PostgreSQLは地図表示・経路探索・REST APIのために再作成可能な投影として利用する。

現在は`data-ingestion`と`data-processing`をDockerコンテナとして実装し、AWS CDKでLambda、S3、EventBridge Scheduler、SQS、CloudWatchへデプロイしている。

```bash
cd infrastructure/cdk
npm install
npm run test:services
npm run test:infra
npm run synth
```

詳細は[サービス境界](docs/architecture/service-boundaries.md)と[サービス実装の順序](docs/guides/service-implementation.md)を参照。

サービスの責務と構成は[services/README.md](services/README.md)を参照。

## ルート構成

- `services/`: アプリケーションサービス
- `infrastructure/`: AWS CDK、Docker Compose、運用スクリプト
- `docs/`: 要件・設計・運用手順

## AI向け案内

- [Codex向け案内](AGENTS.md)
- [Claude向け案内](CLAUDE.md)
