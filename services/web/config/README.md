# 設定

環境差分は `.env.example` に定義したVite環境変数で与えます。実装側の読み取りとデモ固定条件は `src/api/config.ts` にあります。

- `VITE_DATA_MODE`: `mock` または `api`
- `VITE_YUKISAKI_API_URL`: 地図API GatewayのHTTPS URL
- `VITE_MAP_TILE_URL`: MapLibreの背景タイル
- `VITE_PUBLIC_BASE_PATH`: CloudFrontで配信するベースパス
- `VITE_ENABLE_MOCK_FALLBACK`: API失敗時のモック切替

認証情報や秘密値は `VITE_` 変数へ保存しません。
