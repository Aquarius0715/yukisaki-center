# S3 / CloudFront 配備

## ローカル

Node.js 22以上、pnpm 11以上を利用する。

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm build
```

成果物は `dist/`。`VITE_PUBLIC_BASE_PATH=/demo/` のように設定すればサブパス配信にも対応する。APIモードはビルド時に `VITE_DATA_MODE=api` と `VITE_YUKISAKI_API_URL=https://...execute-api.ap-northeast-1.amazonaws.com` を設定する。タイルは `VITE_MAP_TILE_URL` で変更できる。機密情報を `VITE_` 変数へ入れない。

## 配備

非公開S3バケットをCloudFront Origin Access Controlからだけ読める構成を推奨する。`index.html` は短いキャッシュ、ハッシュ付きassetsは長いキャッシュとする。

```bash
AWS_REGION=ap-northeast-1 S3_BUCKET=yukisaki-frontend \
CLOUDFRONT_DISTRIBUTION_ID=XXXXXXXX pnpm deploy:aws
```

スクリプトは `aws s3 sync dist/ s3://... --delete` とCloudFront invalidationを実行する。AWS認証情報、アカウントID、バケット名、Distribution IDはリポジトリへ保存しない。実行前に `aws sts get-caller-identity` で対象アカウントを確認する。

SPAの直接リロードに備え、CloudFrontの403/404カスタムエラーレスポンスを `/index.html`（HTTP 200）へ割り当てる。API GatewayはCloudFrontのWebオリジンをCORS許可し、GET/POST/OPTIONSと `Content-Type` に限定する。配備後の更新は `aws cloudfront create-invalidation --paths '/*'` で反映する。
