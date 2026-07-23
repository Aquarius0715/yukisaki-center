# 設定

環境差分は `.env.example` に定義したVite環境変数で与えます。実装側の読み取りとデモ固定条件は `src/api/config.ts` にあります。

- `VITE_DATA_MODE`: `mock` または `api`
- `VITE_YUKISAKI_API_URL`: 地図API GatewayのHTTPS URL。CloudFront配備では空にして同一オリジンの`/v1/*`を使う
- `VITE_MAPKIT_TOKEN`: Apple Developerで発行するMapKit JS用のドメイン制限付きトークン
- `VITE_PUBLIC_BASE_PATH`: CloudFrontで配信するベースパス
- `VITE_ENABLE_MOCK_FALLBACK`: API失敗時のモック切替

秘密鍵やAWS認証情報は `VITE_` 変数へ保存しません。MapKit JSトークンはブラウザへ配信される公開値として扱い、Apple Developer側で利用ドメインを必ず制限します。
