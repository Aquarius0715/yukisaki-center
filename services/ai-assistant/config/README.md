# 設定

実行時設定はLambda環境変数で渡す。秘密値をこのディレクトリへ置かない。

| 環境変数 | 必須 | 内容 |
|---|---:|---|
| `BEDROCK_MODEL_ID` | 必須 | Converse APIで呼び出すモデルまたはInference Profile ID |
| `BEDROCK_GUARDRAIL_IDENTIFIER` | 任意 | Bedrock Guardrail ID |
| `BEDROCK_GUARDRAIL_VERSION` | Guardrail利用時 | Guardrailのバージョン |

CDKの既定モデルは東京リージョンから利用するJapan GeoのClaude Sonnet 4.5 Inference Profileである。`cdk.json`または`-c bedrockModelId=...`で変更できるが、Structured Outputs対応モデルだけを指定する。
