# yukisaki-center: Claude向けプロジェクト案内

## プロジェクト概要

積雪地域向けに、道路区間ごとの「走りやすさ指数」を可視化し、安全性を考慮した経路案内を提供するMVPである。初期対象地域は新潟県長岡市周辺。

走りやすさ指数は機械学習やLLMではなく、気象、標高・勾配、道路属性、消雪パイプ、除雪履歴などを根拠にしたルールベースで算出する。LLMは地点・条件の抽出や説明文生成だけに使い、通行可否や危険度を決定させない。

要件の正本は[docs/requirements/snow_safe_route_requirements.md](docs/requirements/snow_safe_route_requirements.md)である。作業前に、対象機能とMVPの対象外を確認すること。

## 現在の実装範囲

実装済みなのは、S3を正本とするデータ収集・処理の最初の縦切りである。

- 気象庁公開Atomフィードの定期収集
- S3の`raw/`への原本・メタデータ保存
- Atomフィード項目のJSON Lines正規化
- S3の`normalized/`、`quarantine/`、`manifests/`への出力
- S3 JSON LinesをPostgreSQLへ冪等ロードするコンテナ用ローダーとローカルDBスキーマ
- AWS CDKによるS3、Lambda、EventBridge Scheduler、SQS DLQ、CloudWatchの構築

AWSのRDS/ECS、道路データ、標高・勾配、除雪車GPS、消雪パイプ、走りやすさ指数、経路探索、AI、API、Web画面は未実装または骨組みのみである。未実装の機能を、すでに動作しているかのように扱わない。

## デモ固定条件

- デモ対象は**2026年1月23日の新潟県長岡市石動南町**である。
- デモ機能を実装・検証するときは、現在時刻の取得データではなく、対象日時のスナップショットまたはfixtureを入力として使用する。
- デモ用データには対象日時、対象地域、出典、取得・作成時刻、`is_simulated`を保持し、再現可能にする。

## ディレクトリ構成

```text
docs/                         要件、設計、運用手順
  requirements/               要件定義書
  architecture/               構成図・処理フロー図
  guides/                     実装ガイド

services/                     アプリケーションサービス
  data-ingestion/             外部・仮データをS3 rawへ収集
  data-processing/            正規化、curated化、PostgreSQLロード
  drivability-scoring/        走りやすさ指数（未実装）
  route-planning/             経路探索（未実装）
  ai-assistant/               自然言語・比較・危険説明（未実装）
  api/                        REST API（未実装）
  web/                        Webフロントエンド（未実装）

infrastructure/               AWS・開発基盤
  cdk/                        CDK、Node依存、テスト、AWS CLIラッパー
  compose/                    Docker Compose定義
  postgres/                   ローカルPostgreSQL初期スキーマ
```

新しいアプリケーション実装は、ルート直下へ置かず、必ず責務に対応する`services/`配下へ追加する。AWS関連のコードや設定は`infrastructure/`配下へ置く。ドキュメントは`docs/`内の分類に従う。

各サービス内は`src/`、`tests/`、`config/`、`docs/`、`AGENTS.md`、`Dockerfile`、`README.md`へ責務を分離する。サービス固有の`AGENTS.md`は、この全体案内を補完するAI向け指示である。

## 作業上の注意

- 既存のユーザー変更を上書き・削除しない。作業前後に`git status --short`を確認する。
- AWSへ変更を加える前に、`infrastructure/cdk/`で`npm test`、`npm run build`、`npm run synth`を実行する。
- AWSへの`cdk deploy`、リソース削除、データ削除は、利用者が明確に依頼した場合だけ行う。
- デプロイ・AWS CLI操作は`infrastructure/cdk/`を作業ディレクトリにする。ホストCLIに依存せず、必要に応じて`npm run aws -- <AWS CLI command>`を使う。
- S3（`raw -> normalized -> curated`）を全データの正本とし、外部データは直接DBへ書かない。PostgreSQLはS3から再作成できる配信用・空間検索用の派生ストアとする。
- LLMは自然言語の条件抽出と根拠に基づく説明だけに使用する。指数、通行可否、危険度を決定させない。
- 仮データには`is_simulated: true`を保持し、実データであるかのように表示・説明しない。
- 公開データの利用規約、出典表示、機械取得可否を確認せずに新しい収集先を追加しない。

## 案内ファイルの保守と知識共有

- サービス構成、データ契約、AWS構成、実装済み範囲、主要コマンドが変わったときは、この案内と`AGENTS.md`を同じ作業で更新する。
- CodexとClaudeで異なるプロジェクト事実を持たない。共通の事実は両方の案内へ同じ内容で反映し、詳細な設計判断・手順・履歴は`docs/`へ記録する。
- `AGENTS.md`と`CLAUDE.md`には、作業判断に必要な安定した要約だけを置く。実行ログ、長い設計経緯、コード詳細、生成物一覧を追記して肥大化させない。
- 詳細化が必要になった場合は、該当する`docs/requirements/`、`docs/architecture/`、`docs/guides/`、または`services/<service>/README.md`を追加・更新し、ここからリンクする。
- 両ファイルの内容は、見出し名以外は同等に保つ。

## 主要コマンド

```bash
cd infrastructure/cdk
npm test
npm run build
npm run synth
```

詳細は[docs/README.md](docs/README.md)、サービスの責務は[services/README.md](services/README.md)を参照する。
