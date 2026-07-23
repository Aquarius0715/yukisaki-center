# S3 / CloudFront 配備

## ローカル

Node.js 22以上、pnpm 11以上を利用する。

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm build
```

成果物は `dist/`。`VITE_PUBLIC_BASE_PATH=/demo/` のように設定すればサブパス配信にも対応する。APIモードはビルド時に `VITE_DATA_MODE=api` と `VITE_YUKISAKI_API_URL=https://...execute-api.ap-northeast-1.amazonaws.com` を設定する。Apple Maps表示には`VITE_MAPKIT_TOKEN`へMapKit JS用のドメイン制限付きトークンを設定し、Apple Developer側の許可ドメインにCloudFrontの配信ドメインを登録する。秘密鍵やAWS認証情報を `VITE_` 変数へ入れない。

## CDKによる配備

正規のAWS構成は`infrastructure/cdk/lib/web-stack.ts`で管理する。CDK synth時にDockerでWebを本番ビルドし、非公開S3、CloudFront Origin Access Control、SPAフォールバック、API Gatewayへの`/v1/*`・`/healthz`転送、成果物アップロードとキャッシュ無効化を作成する。CloudFrontはデプロイ直後に無効である。

MapKit JSトークンは`yukisaki/<environment>/web/mapkit-js-token`という名前でSecrets Managerへ保存する。トークン自体はブラウザへ配信される公開値だが、GitやCloudFormationへ直接記録せず、Apple Developer側でCloudFrontドメインへ制限する。初回またはローテーション時だけ、Git管理外の`services/web/env.local`から同期する。

```bash
cd infrastructure/cdk
npm run web:secret:sync -- --profile yukisaki-dev
npm run web:deploy -- --profile yukisaki-dev
npm run web:enable -- --profile yukisaki-dev
npm run web:status -- --profile yukisaki-dev
```

`npm run deploy|diff|synth`も同じラッパーを通り、デプロイ時はSecrets Managerからトークンを取得してDockerビルドへだけ渡す。値はコマンド出力へ表示しない。

全サービスとまとめて操作するときは`env:start|stop|status`を使用する。CloudFrontの有効・無効変更は非同期であり、`status=Deployed`になるまで数分かかることがある。Web配信S3は停止時も削除しない。

`pnpm deploy:aws`は既存バケットとDistributionへ手動同期する補助スクリプトとして残している。通常運用では使用せず、CDKを正本とする。AWS認証情報、アカウントID、バケット名、Distribution IDはリポジトリへ保存しない。
