# データ処理・PostgreSQLロードサービス

S3 `raw/open-meteo/weather-window/`を読み、rawオブジェクトのSHA-256を検証してから、基準時刻の前後3時間を7件のレコードへ正規化し、S3 `normalized/`とAWS RDS PostgreSQLへ冪等保存する。外部APIからPostgreSQLへ直接書き込まない。

```text
S3 raw response.json
  -> WeatherWindowLoader Lambda
  -> S3 normalized/open-meteo/weather-window/.../part-00000.jsonl
  -> RDS PostgreSQL weather_hourly_windows
```

`relative_hour=-3,-2,-1,0`は`data_kind=observed`、`+1,+2,+3`は`data_kind=forecast`である。DB接続情報はSecrets Managerから取得し、RDSはprivate subnetに置く。

## 構成

- `src/data_processing/weather/window_loader.py`: 正規化・S3出力・DB UPSERT Lambda
- `tests/weather/test_window_loader.py`: 7時間窓の契約テスト
- `config/requirements-loader.txt`: LambdaのPostgreSQLドライバー
- `docs/contract.md`: テーブル・項目契約
- `AGENTS.md`: AI向け作業指示
