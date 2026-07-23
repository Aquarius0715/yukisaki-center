# AI作業指示

## 作業範囲

このディレクトリを対象に作業するとき、編集可能な範囲は`services/web/`配下だけとする。

- `services/web/`以外のソース、ドキュメント、AWS CDK、設定ファイルは変更しない。
- リポジトリ外の依存関係を確認するための読み取りは許可するが、変更が必要になった場合は作業を止めて利用者へ相談する。
- Webだけでは完結しないAPI、データ契約、インフラ変更を勝手に実施しない。
- `.env.local`、トークン、秘密鍵、AWS認証情報をGitへ追加しない。

## Git操作

commitとpushには`services/web/`配下の変更だけを含める。

- 作業前後に`git status --short`と`git diff -- services/web`で対象を確認する。
- ステージングは`git add -- services/web`のように対象パスを明示する。
- `git add -A`、`git add .`、リポジトリ全体を対象にしたcommitを使用しない。
- `services/web/`以外の既存変更は、取り消し、stash、上書き、commit、pushしない。
- push前に`git diff --cached --name-only`を確認し、全ファイルが`services/web/`配下であることを検証する。
- Web以外のファイルがステージ済みの場合はpushせず、対象を安全に分離する。

## サービス責務

このサービスは表示だけを担当する。データはREST APIから取得し、S3やPostgreSQLへ直接接続しない。デモ日・対象地域・データ時刻・仮データ注記を画面で明示し、指数や危険理由をフロントエンドで再計算しない。
