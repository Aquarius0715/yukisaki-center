# yukisaki-center: Codex向けプロジェクト案内

## プロジェクト概要

積雪地域向けに、道路区間ごとの「走りやすさ指数」を可視化し、安全性を考慮した経路案内を提供するMVPである。データ取得・地図対象地域は新潟県長岡市全域。

走りやすさ指数は機械学習やLLMではなく、気象、標高・勾配、道路属性、消雪パイプ、除雪履歴などを根拠にしたルールベースで算出する。LLMは地点・条件の抽出や説明文生成だけに使い、通行可否や危険度を決定させない。

要件の正本は[docs/requirements/snow_safe_route_requirements.md](docs/requirements/snow_safe_route_requirements.md)である。作業前に、対象機能とMVPの対象外を確認すること。

## 現在の実装範囲

気象の縦切りは、S3を正本としてAWS RDS PostgreSQLへロードする構成で実装している。

- Open-Meteo Historical Weather APIから基準時刻3時間前〜基準時刻の実気象を取得
- Open-Meteo Historical Forecast APIから基準時刻1〜3時間後の当時予報を取得
- 基準時刻は2026-01-23 12:00 JST。道路は長岡市のOSM行政界ポリゴン、気象は公式市域端点を含む約9km間隔の5×7グリッド35地点を対象とする
- API原本・メタデータをS3 `raw/`へ保存し、35地点×7時間の245件を`normalized/`へ保存
- private subnetのRDS PostgreSQL `weather_hourly_windows`へ冪等UPSERT
- 道路ネットワークは独立したECS FargateスタックでOpenStreetMapから収集し、道路専用S3バケットの`raw/osm/road-network/`へ保存
- 道路完了manifestをEventBridgeで検知し、Step FunctionsとLambdaで道路名に基づく消雪パイプ仮データを生成する。生成した`raw/simulated/snow-pipe/`と道路を統合した`curated/road-segments/`は、道路入力バケットとは別のSnow Pipe専用S3バケットへ保存
- curated道路はSQSを介してprivate Lambdaから共通RDS PostgreSQL `yukisaki`の`road_segments`と`snow_pipe_history`へ冪等ロードする。気象と同じDBインスタンス・DBユーザー・Secrets Manager認証情報を使用し、RDS停止中もS3処理を継続してロード要求をキューに保持する
- GPSシミュレータは1つのECS Fargateタスク内で3台の除雪車を5秒間隔で走行させ、3台の経路の和集合でマッピング済み全道路区間を巡回する。固定デモ時刻`observed_at`と実受信時刻`received_at`を分離し、最新位置は`received_at`で更新する。EventBridgeカスタムバスから2つのSQSへfan-outし、S3 `raw/`への不変保存と、道路区間へマッチングした`normalized/`・`curated/snowplow-passages/`を経由する共通RDS投影を分離する
- 走りやすさ指数はデモ開始時に全道路を一括評価し、その後はGPSロード後にSQSから通過区間を差分評価する。気象、勾配、消雪パイプ、最終除雪時刻を決定的なルールへ入力し、S3 `curated/drivability-scores/`を正本として共通RDS `drivability_scores`へ投影する
- 消雪パイプ仮データは`road-name-active-v2`を使い、道路名がある区間を`snow_pipe=true`かつ`operation_status=active`、道路名がない区間を`inactive`とする
- REST APIはAPI Gateway HTTP APIとDockerイメージLambdaで実装し、共通RDSの道路・指数・消雪パイプ・最新除雪車位置をGeoJSONで返す。道路Geometryの外接矩形をRDSへ保持し、DB側の`bbox`条件とSQL件数上限で絞る。GPSは別エンドポイントから更新できる
- 経路探索は道路収集時のOSMノード・分割ノード・方向・速度・accessをS3 curatedからPostGIS/pgRoutingへ投影し、地点スナップ、動的な指数コスト、K最短候補、危険区間集計を行うDocker Lambdaと`POST /v1/routes`をローカル実装済み。AWSデプロイとルーティング属性を含む道路の再収集・再ロードは未実施
- AIサービスはAmazon BedrockのStructured Outputsを使うDocker Lambdaとして実装し、自然言語の条件抽出、確定済み経路の比較説明、確定済み危険要因の説明を別APIで提供する。識別子変更やBedrock失敗時は定型文へフォールバックし、指数・順位・通行可否は決定しない
- WebはReactとApple MapKit JSで実装し、非公開S3とCloudFront OACで配信するCDKスタックを持つ。CloudFrontからAPI Gatewayへ`/v1/*`を同一オリジン転送し、デプロイ直後は無効とする
- MapKit JSトークンはGit管理外の`services/web/env.local`からSecrets Managerへ同期し、CDKデプロイ時だけ取得する。トークンはCloudFrontドメインへ制限し、ログやCloudFormationへ直接出力しない
- AWS CDKでは気象データパイプライン、道路収集、消雪パイプ処理、GPS・指数処理、経路探索、公開API、AIアシスタント、Web配信を別スタックとして管理。経路探索スタックだけはローカル実装済み・AWS未デプロイ
- Weather、道路、消雪パイプmanifestはEventBridge Ruleを共通の入口とし、3つのRuleはデプロイ時に`DISABLED`。単一RDS、3つのRule、関連Lambda（Map APIを含む）、道路Fargate、GPS Fargate、Web CloudFrontは`env:start|stop|status`でまとめて管理する
- 全Collectorは共通メタデータ契約で`run_id`、取得日時、対象期間、出典URL、SHA-256をS3 metadata/manifestへ保持し、PostgreSQLへ直接書かない
- `services/`直下の8サービスはすべてDockerfileを持ち、ローカルテストもDocker Composeから実行する
- 2026-07-23に長岡市全域版をAWSへデプロイ・再収集済み。共通RDSで気象35地点245件、道路133,013件、道路名あり36,383件すべての消雪パイプ`active`、全道路133,013件の走りやすさ指数を確認した。S3 raw/normalized/curatedを正本として維持し、公開APIで消雪パイプ`active`と指数を確認済み
- 2026-07-22にAIアシスタントスタックと3つのPOST APIをAWSへデプロイ済み。API Gateway、Docker Lambda、安全な定型文フォールバックを実環境で確認し、Lambdaは予約同時実行数`0`へ戻した。Claude実推論はAnthropic use case details formの提出待ちである
- 旧JMA Atom Collector、旧Normalizer、固定fixture Lambda、旧気象用EventBridge SchedulerはAWSから削除済み
- AWS実行系は開発・デモ時だけ起動し、`npm run env:start|stop|status`で管理する。S3等の正本は停止対象にしない
- RDSの直接確認は`db:start|stop`でRDSとSSM踏み台をまとめて起動・停止し、Session Managerで入って踏み台内の`yukisaki-psql`から行う。RDSは非公開とし、踏み台には受信ルールを設けない

標高・勾配は未実装または骨組みのみである。経路探索はローカル実装済みだがAWS未デプロイであり、既存AWS道路も新しいグラフ契約では未ロードである。Web画面とAWS配信基盤は実装・デプロイ済みである。AIサービスはAWSデプロイ済みだが、Claude実推論はAnthropic用途申請が完了するまで利用できない。除雪車GPS、消雪パイプ、走りやすさ指数はデモ用の仮データ・ルールベース処理であり、実設備データではない。未実装・利用条件未完了の機能を、すでに動作しているかのように扱わない。

## デモ固定条件

- デモ対象日は**2026年1月23日**、データ範囲は**新潟県長岡市全域**である。石動南町は初期確認地点として維持する。
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
  route-planning/             PostGIS・pgRoutingによる経路探索
  ai-assistant/               Bedrockによる自然言語・比較・危険説明
  api/                        道路・指数・除雪車のREST API
  web/                        React・Apple MapKit JS Webフロントエンド

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

- サービス構成、データ契約、AWS構成、実装済み範囲、主要コマンドが変わったときは、この案内ともう一方のAI向け案内を同じ作業で更新する。
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
