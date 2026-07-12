# 入出力契約

入力は許可済みHTTPS取得元または固定fixture、出力はS3 `raw/{source}/{dataset}/ingest_date=.../run_id=.../`である。原本、取得メタデータ、manifestを別オブジェクトとして保存する。

| サブパッケージ | 入力 | `source` | 状態 |
|---|---|---|---|
| `weather/` | 気象庁Atomフィード（HTTPS） | `jma` | 実装済み |
| `road/` | 道路ネットワーク公開データ（想定） | `osm` | 未実装 |
| `snow_pipe/` | 固定fixture | `snow-pipe` | 未実装。出力は`is_simulated: true` |
| `plow_gps/` | 固定fixture | `plow-gps` | 未実装。出力は`is_simulated: true` |
