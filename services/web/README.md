# Yukisaki Webフロントエンド

雪国向けナビゲーション「Yukisaki」のReact Webアプリです。MapLibreで道路GeoJSONを表示し、REST APIまたは再現可能なモックAPIから道路状態、消雪パイプ、除雪車、経路候補を取得します。Web側は受け取った指数や危険理由を表示し、再計算しません。

## ディレクトリ

```text
src/                 React / TypeScriptソース
  api/               API契約、HTTPクライアント、モード切替
  data/mock/         API未実装期間のモックAPI
  features/map/      MapLibre地図
  hooks/             データ取得フック
public/data/         ブラウザ配信用GeoJSON
docs/                API契約、AWS配備手順
scripts/             S3 / CloudFront配備スクリプト
config/              環境設定の説明
legacy-static/       移行前の静的HTML版（参照用）
```

## ローカル起動

Node.js 22以上、pnpm 11以上を使用します。

```powershell
corepack pnpm install
corepack pnpm dev
```

ブラウザで `http://localhost:8443` を開きます。

## 検証とビルド

```powershell
corepack pnpm typecheck
corepack pnpm build
corepack pnpm preview
```

本番成果物は `dist/` に生成されます。Dockerでは同じ型チェックとビルドを実行し、nginxから成果物を配信します。

## データモード

`.env.example` を `.env.local` へコピーして設定します。通常は `VITE_DATA_MODE=mock`、実API接続時は `api` に変更します。デモ条件は2026年1月23日・新潟県長岡市石動南町です。現在の道路GeoJSON、道路状態、消雪パイプ、除雪車、経路、天気はデモ用の仮データです。

API仕様は [docs/API_CONTRACT.md](docs/API_CONTRACT.md)、S3・CloudFront配備は [docs/AWS_DEPLOY.md](docs/AWS_DEPLOY.md) を参照してください。AWSへの配備は明示的に実行した場合だけ行われます。
