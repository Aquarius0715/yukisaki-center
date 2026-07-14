# DBローダー設定

| 環境変数 | 用途 |
|---|---|
| `DATABASE_SECRET_ARN` | RDS認証情報を持つSecrets Manager ARN |
| `DATABASE_NAME` | DB名。既定`yukisaki` |

Lambdaはprivate subnet内で実行し、S3 Gateway EndpointとSecrets Manager Interface Endpointを利用する。秘密値を環境変数へ直接保存しない。
