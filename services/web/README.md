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

`.env.example` を `.env.local` へコピーして設定します。`VITE_MAPKIT_TOKEN`にはApple Developerで発行するMapKit JS用のドメイン制限付きトークンを設定します。ローカル確認ではトークンの許可ドメインに`localhost`も追加してください。`VITE_DATA_MODE=api` と `VITE_YUKISAKI_API_URL` で公開APIへ接続します。初回は`/healthz`と`/v1/map/snapshot`、道路選択時は`/v1/road-segments/{id}`、除雪車は`/v1/snowplows`を5秒間隔で取得します。地点検索はApple Mapsの入力補完・名称検索、経路画面は`/v1/routes`へ接続し、確定済み経路の比較・注意説明だけAIアシスタントAPIへ接続します。自然言語条件抽出はWeb画面へ公開しません。

`VITE_ENABLE_MOCK_FALLBACK=true`でも、道路一覧・snapshot、地点検索・経路探索・AI説明のエラーはモック成功へ置き換えません。道路更新失敗時は最後の実API値またはキャッシュを保持します。モックへ切り替わるのは除雪車の表示データと、公開天気APIが未実装のための固定天気表示だけです。Claude実推論を利用できない場合はAI APIが返す`fallback_used: true`の定型説明を明示します。

デモ条件は2026年1月23日・新潟県長岡市全域で、石動南町を初期確認地点として扱います。道路付加情報、指数、消雪パイプ、GPSはAPIでも `is_simulated` を明示したデモデータです。天気、走行軌跡・本日走行距離は公開API未提供です。

道路はメモリキャッシュに加えてIndexedDBへ最大12表示範囲・24時間保存します。再訪時は保存済み道路を先に表示してからAPIで更新します。近距離・広域とも固定空間タイルを使い、近距離は最大2リクエストずつ1,500区間単位で段階取得します。地図停止後に最新範囲だけを取得し、MapKit Overlayは全再生成せず差分更新します。AWS配信では同じタイルをCloudFrontで全端末共有します。再試行操作ではブラウザ内の両キャッシュを消去します。

地図取得は`view=map`を指定し、Geometry、道路ID・名称・種別、走りやすさ指数、消雪パイプ状態だけを読み込みます。指数根拠、勾配、延長、除雪履歴などの詳細は道路タップ時に1区間だけ取得します。

API仕様は [docs/API_CONTRACT.md](docs/API_CONTRACT.md)、S3・CloudFront配備は [docs/AWS_DEPLOY.md](docs/AWS_DEPLOY.md) を参照してください。AWSではCDKが非公開S3、CloudFront OAC、SPAフォールバック、API Gatewayへの同一オリジン転送、静的成果物の配備を管理します。AWSへの配備は明示的に実行した場合だけ行われます。
