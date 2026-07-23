# Yukisaki Webフロントエンド

雪国向けナビゲーション「Yukisaki」のReact Webアプリです。MapKit JSのApple Mapsを背景地図として、OpenStreetMap由来の道路GeoJSONを重ねて表示します。REST APIまたは再現可能なモックAPIから道路状態、消雪パイプ、除雪車、経路候補を取得し、Web側では受け取った指数や危険理由を再計算しません。

## ディレクトリ

```text
src/                 React / TypeScriptソース
  api/               API契約、HTTPクライアント、モード切替
  data/mock/         API未実装期間のモックAPI
  features/map/      MapKit JS地図と独自オーバーレイ
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

`.env.example` を `.env.local` へコピーして設定します。`VITE_MAPKIT_TOKEN`にはApple Developerで発行したMapKit JS用のドメイン制限付きトークンを設定します。ローカル確認ではトークンの許可ドメインに`localhost`も追加してください。`VITE_DATA_MODE=api` と `VITE_YUKISAKI_API_URL` で公開Map APIへ接続します。初回は `/v1/map/snapshot`、除雪車は `/v1/snowplows` を5秒間隔で取得します。API停止時に `VITE_ENABLE_MOCK_FALLBACK=true` ならモック表示へ切り替わります。

デモ条件は2026年1月23日・新潟県長岡市全域で、石動南町を初期確認地点として扱います。道路付加情報、指数、消雪パイプ、GPSはAPIでも `is_simulated` を明示したデモデータです。現在のMap API対象外である経路候補、目的地検索、天気、走行軌跡はWebモックを使用します。

API仕様は [docs/API_CONTRACT.md](docs/API_CONTRACT.md)、S3・CloudFront配備は [docs/AWS_DEPLOY.md](docs/AWS_DEPLOY.md) を参照してください。AWSではCDKが非公開S3、CloudFront OAC、SPAフォールバック、API Gatewayへの同一オリジン転送、静的成果物の配備を管理します。AWSへの配備は明示的に実行した場合だけ行われます。
