# サービス構成

S3を全データの正本とする。各サービスは、別サービスの実装を直接参照せず、S3、PostgreSQL、REST API、イベントで定義された契約だけを介して連携する。

| サービス | 責務 | 入力 | 出力 | 状態 |
|---|---|---|---|---|
| `data-ingestion/` | 外部・仮データを収集して原本保存 | 公開API、fixture | S3 `raw/` | 気象庁フィードを実装済み |
| `data-processing/` | 検証・正規化・curated化・DBロード | S3 `raw/` / `normalized/` | S3 `normalized/` / `curated/`、PostgreSQL | 気象正規化とJSON Linesローダーを実装済み |
| `drivability-scoring/` | 区間ごとの指数・信頼度を算出 | curated、気象、設備、GPS | S3 `curated/scores/`、PostgreSQL | 設計済み |
| `route-planning/` | 指数をコストとして経路探索 | PostgreSQL/PostGIS | 経路候補 | 設計済み |
| `ai-assistant/` | 自然言語解析、経路比較、危険説明 | REST APIが返す根拠データ | 構造化条件、説明文 | 設計済み |
| `api/` | REST API、認可、入力検証 | PostgreSQL、各サービス | JSON / GeoJSON | 設計済み |
| `web/` | 地図・経路・説明の利用者画面 | REST API | ブラウザ画面 | 設計済み |

## 正本と派生データ

```text
data-ingestion -> S3 raw
data-processing -> S3 normalized / curated -> PostgreSQL
drivability-scoring -> S3 curated/scores + PostgreSQL
route-planning / api -> PostgreSQL
ai-assistant -> api が取得した根拠データのみを使用
web -> REST API
```

PostgreSQLのデータはS3の`curated/`から再作成可能でなければならない。収集サービスが外部レスポンスを直接PostgreSQLへ保存すること、LLMが指数・通行可否を決めることは禁止する。

## 共通ディレクトリ規約

各サービスは次の責務単位に分ける。ルート直下へ実装やテストを追加しない。

```text
services/<service>/
  src/          実装コード
  tests/        単体テスト
  config/       非秘密の実行設定・設定説明
  docs/         サービス固有の契約・設計
  AGENTS.md     AI向け作業指示
  Dockerfile    実行・テスト用コンテナ定義
  README.md     人間向け概要
```
