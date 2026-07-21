# yukisaki-center: Claude向けプロジェクト案内

## プロジェクト概要

積雪地域向けに、道路区間ごとの「走りやすさ指数」を可視化し、安全性を考慮した経路案内を提供するMVPである。初期対象地域は新潟県長岡市周辺。

走りやすさ指数は機械学習やLLMではなく、気象、標高・勾配、道路属性、消雪パイプ、除雪履歴などを根拠にしたルールベースで算出する。LLMは地点・条件の抽出や説明文生成だけに使い、通行可否や危険度を決定させない。

要件の正本は[docs/requirements/snow_safe_route_requirements.md](docs/requirements/snow_safe_route_requirements.md)である。作業前に、対象機能とMVPの対象外を確認すること。

## 現在の実装範囲

気象の縦切りは、S3を正本としてAWS RDS PostgreSQLへロードする構成で実装している。

- Open-Meteo Historical Weather APIから基準時刻3時間前〜基準時刻の実気象を取得
- Open-Meteo Historical Forecast APIから基準時刻1〜3時間後の当時予報を取得
- 基準時刻は2026-01-23 12:00 JST、地点は長岡市石動南町（37.442762, 138.790865）
- API原本・メタデータをS3 `raw/`へ保存し、7件のJSON Linesを`normalized/`へ保存
- private subnetのRDS PostgreSQL `weather_hourly_windows`へ冪等UPSERT
- 道路ネットワークは独立したECS FargateスタックでOpenStreetMapから収集し、道路専用S3バケットの`raw/osm/road-network/`へ保存
- 道路完了manifestをEventBridgeで検知し、Step FunctionsとLambdaで道路名に基づく消雪パイプ仮データを生成する。生成した`raw/simulated/snow-pipe/`と道路を統合した`curated/road-segments/`は、道路入力バケットとは別のSnow Pipe専用S3バケットへ保存
- curated道路はSQSを介してprivate Lambdaから共通RDS PostgreSQL `yukisaki`の`road_segments`と`snow_pipe_history`へ冪等ロードする。気象と同じDBインスタンス・DBユーザー・Secrets Manager認証情報を使用し、RDS停止中もS3処理を継続してロード要求をキューに保持する
- GPSシミュレータは1つのECS Fargateタスク内で3台の除雪車を5秒間隔で走行させ、EventBridgeカスタムバスへ`is_simulated: true`の位置イベントを送信する。2つのSQSへfan-outし、S3 `raw/`への不変保存と、道路区間へマッチングした`normalized/`・`curated/snowplow-passages/`を経由する共通RDS投影を分離する
- 走りやすさ指数はGPSロード後にSQSから起動し、気象、勾配、消雪パイプ、最終除雪時刻を決定的なルールで評価する。S3 `curated/drivability-scores/`を正本とし、共通RDS `drivability_scores`へ投影する
- REST APIはAPI Gateway HTTP APIとDockerイメージLambdaで実装し、共通RDSの道路・指数・消雪パイプ・最新除雪車位置をGeoJSONで返す。道路は`bbox`で絞り、GPSは別エンドポイントから更新できる
- AWS CDKでは気象データパイプライン、道路収集、消雪パイプ処理、GPS・指数処理、公開APIを別スタックとして管理
- Weather、道路、消雪パイプmanifestはEventBridge Ruleを共通の入口とし、3つのRuleはデプロイ時に`DISABLED`。単一RDS、3つのRule、関連Lambda（Map APIを含む）、道路Fargate、GPS Fargateは`env:start|stop|status`でまとめて管理する
- 全Collectorは共通メタデータ契約で`run_id`、取得日時、対象期間、出典URL、SHA-256をS3 metadata/manifestへ保持し、PostgreSQLへ直接書かない
- `services/`直下の8サービスはすべてDockerfileを持ち、ローカルテストもDocker Composeから実行する
- 2026-07-21に気象、道路、消雪パイプ、GPS・指数、公開APIの5スタックをAWSへデプロイ済み。気象7件・道路4,944件・消雪パイプ履歴4,944件に加え、GPSモック3台のS3 raw/normalized/curated、共通RDSの最新位置・通過履歴、S3/RDSの走りやすさ指数を確認した。公開APIでは道路GeoJSON、3台の最新位置、道路IDとの紐付け、CORSを実レスポンスで確認済み。旧Snow Pipe専用RDS・VPC・Secret・自動バックアップは削除済みで、S3正本は維持している
- 旧JMA Atom Collector、旧Normalizer、固定fixture Lambda、旧気象用EventBridge SchedulerはAWSから削除済み
- AWS実行系は開発・デモ時だけ起動し、`npm run env:start|stop|status`で管理する。S3等の正本は停止対象にしない
- RDSの直接確認は`db:start|stop`でRDSとSSM踏み台をまとめて起動・停止し、Session Managerで入って踏み台内の`yukisaki-psql`から行う。RDSは非公開とし、踏み台には受信ルールを設けない

標高・勾配、経路探索、AI、Web画面は未実装または骨組みのみである。除雪車GPS、消雪パイプ、走りやすさ指数はデモ用の仮データ・ルールベース処理であり、実設備データではない。未実装の機能を、すでに動作しているかのように扱わない。

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
  gps-simulator/              除雪車3台のGPSモック送信
  data-ingestion/             外部・仮データをS3 rawへ収集
  data-processing/            正規化、curated化、PostgreSQLロード
  drivability-scoring/        ルールベースの走りやすさ指数
  route-planning/             経路探索（未実装）
  ai-assistant/               自然言語・比較・危険説明（未実装）
  api/                        道路・指数・除雪車のREST API
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
npm run env:status -- --profile yukisaki-dev
```

詳細は[docs/README.md](docs/README.md)、サービスの責務は[services/README.md](services/README.md)を参照する。
