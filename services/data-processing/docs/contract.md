# 気象処理・DBロード契約

## 時間窓

| relative_hour | data_kind | データ源 |
|---:|---|---|
| -3〜0 | `observed` | Historical Weather API |
| 1〜3 | `forecast` | Historical Forecast API |

必ず7件を1トランザクションでUPSERTする。必要な時刻が1件でも欠ける場合はDBを更新しない。

入力は必ずS3 `raw/`オブジェクトとし、S3メタデータの`sha256`と本文から再計算したSHA-256が一致しない場合は、正規化もDB更新も行わない。処理manifestにも収集時の`run_id`、対象期間、出典、取得日時、チェックサムを引き継ぐ。

## PostgreSQL

テーブル`weather_hourly_windows`には次を保持する。

- 地点ID・名称・緯度経度
- `reference_time`、`valid_time`、`relative_hour`、`data_kind`
- 気温、湿度、降水量、降雪量、積雪深、WMO天気コード、風速、突風
- 出典URL、取得時刻、`run_id`、`schema_version`、`is_simulated`

主キーは地点・基準時刻・有効時刻・種別から生成したSHA-256である。`data_load_runs`にロード元S3キーと件数を記録し、DBをS3から再構築可能にする。
