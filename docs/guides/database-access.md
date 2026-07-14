# SSM踏み台からRDS PostgreSQLを確認する

## 構成

RDSはprivate isolated subnetのまま公開しない。受信ポートを持たないEC2踏み台へAWS Systems Manager Session Managerで入り、踏み台内のPostgreSQL 16クライアントからRDSへ接続する。

```text
ローカルのターミナル
  -> Session Manager（IAM認証）
  -> SSM踏み台EC2（t4g.micro、受信ルールなし）
  -> 踏み台内のyukisaki-psql
  -> RDS PostgreSQL:5432
```

- SSH鍵と22番ポートは使用しない。
- RDSのSecurity Groupは踏み台のSecurity Groupからの5432だけを許可する。
- 踏み台は対象DBシークレットだけをSecrets Managerから読み取れる。
- `yukisaki-psql`が接続時に認証情報を取得し、ファイルやコマンドラインへパスワードを保存しない。
- ローカルへの`psql`、Session Manager Pluginの直接インストール、ポートフォワーディングは不要である。

## 接続手順

作業ディレクトリは`infrastructure/cdk/`とする。

### 1. RDSと踏み台を起動する

```bash
cd infrastructure/cdk
npm run db:start -- --profile yukisaki-dev
```

RDSが停止中なら利用可能になるまで待ち、踏み台を起動してSSMが`Online`になるまで待つ。このコマンドはWeather・道路のEventBridge Ruleを有効化しない。

状態だけ確認する場合は次を使う。

```bash
npm run db:status -- --profile yukisaki-dev
```

### 2. Session Managerで踏み台へ入る

```bash
npm run db:shell -- --profile yukisaki-dev
```

ローカルではAWS CLIとSession Manager Pluginを含む最小Dockerイメージだけを使用する。接続すると踏み台のシェルが表示される。

AWSコンソールを使う場合は、東京リージョンのEC2画面で`yukisaki-dev-database-bastion`を選び、「接続」「セッションマネージャー」「接続」の順に開く。

### 3. 踏み台内でpsqlを開く

```bash
yukisaki-psql
```

よく使う確認コマンドは次のとおり。

```sql
\conninfo
\dt
\d weather_hourly_windows

SELECT relative_hour, data_kind, valid_time, temperature_c,
       precipitation_mm, snowfall_cm, snow_depth_m
FROM weather_hourly_windows
ORDER BY relative_hour;

SELECT run_id, dataset, source_key, loaded_at, record_count
FROM data_load_runs
ORDER BY loaded_at DESC;
```

長い結果が`less`で開いた場合は`q`で結果表示を閉じる。`psql`自体は`\q`で終了する。

踏み台内でSQLを1回だけ実行することもできる。

```bash
yukisaki-psql -c \
  'SELECT relative_hour, data_kind, valid_time FROM weather_hourly_windows ORDER BY relative_hour;'
```

### 4. 終了する

`psql`を`\q`で終了し、踏み台のシェルを`exit`で閉じる。その後、ローカルからRDSと踏み台をまとめて停止する。

```bash
npm run db:stop -- --profile yukisaki-dev
```

`db:start`と`db:stop`は、RDSと踏み台を常に一組として起動・停止する。`db:stop`は両リソースへ停止要求を出すため、直後の状態は`stopping`になることがある。EventBridge RuleやLambdaの状態は変更しない。開発環境全体を停止するときは、従来どおり`npm run env:stop -- --profile yukisaki-dev`も使用する。

## コスト

踏み台の実行中はFree Tier対象の`t4g.micro`とパブリックIPv4の利用枠または時間料金が消費される。停止中も8 GiBの暗号化EBS料金は残る。接続が終わったら踏み台を停止する。NAT GatewayやSSM用Interface Endpointを常設しない構成のため、開発環境の固定費を抑えられる。

## トラブルシューティング

- `DatabaseBastionInstanceId`がない: 最新CDKをデプロイする。
- SSMが`None`または`ConnectionLost`: `npm run db:start`を実行し、`Online`になるまで待つ。
- `yukisaki-psql: command not found`: 踏み台で`sudo cloud-init status --wait`を実行し、初期設定完了後に再実行する。
- 認証エラー: ローカルで`npm run aws -- sts get-caller-identity --profile yukisaki-dev`を実行してAWS認証を確認する。
