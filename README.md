# yukisaki-center

雪道の走りやすさ可視化・安全経路案内システムのMVPリポジトリ。

## データパイプライン

気象・道路・GPSなどのデータは、まずS3へ不変保存する。S3の`raw/`、`normalized/`、`curated/`を正本とし、PostgreSQLは地図表示・経路探索・REST APIのために再作成可能な投影として利用する。

すべてのサービスにDockerfileを配置している。現在の収集基盤はAWS CDKでLambda、ECS Fargate、EventBridge、S3、SQS、CloudWatchを管理する。除雪車GPSモックは3台を1つのFargateタスクで動かし、EventBridgeとSQS経由でS3、PostgreSQL、走りやすさ指数へ反映する。道路と除雪車の最新位置はAPI GatewayとDockerイメージLambdaのGeoJSON APIからフロントエンドへ提供する。React Webは非公開S3とCloudFront OACで配信し、APIを同一オリジンで利用する。

```bash
cd infrastructure/cdk
npm install
npm run test:services
npm run test:infra
npm run synth
npm run env:status -- --profile yukisaki-dev
```

RDS PostgreSQLをSSM踏み台内の`psql`から確認する手順は[DB接続ガイド](docs/guides/database-access.md)を参照。

詳細は[サービス境界](docs/architecture/service-boundaries.md)、[GPSパイプライン](docs/guides/gps-pipeline.md)、[フロントエンドAPI](docs/guides/frontend-map-api.md)、[サービス実装の順序](docs/guides/service-implementation.md)を参照。

サービスの責務と構成は[services/README.md](services/README.md)を参照。

## ルート構成

- `services/`: アプリケーションサービス
- `infrastructure/`: AWS CDK、Docker Compose、運用スクリプト
- `docs/`: 要件・設計・運用手順

## AI向け案内

- [Codex向け案内](AGENTS.md)
- [Claude向け案内](CLAUDE.md)
