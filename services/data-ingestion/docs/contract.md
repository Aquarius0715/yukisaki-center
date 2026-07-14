# 気象収集の入出力契約

## 基準時刻と地点

| 項目 | 値 |
|---|---|
| 基準時刻 | `2026-01-23T12:00:00+09:00` |
| 地点 | 新潟県長岡市石動南町 |
| 緯度・経度 | `37.442762`, `138.790865` |
| タイムゾーン | `Asia/Tokyo` |

## データ源

- `relative_hour=-3..0`: [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)
- `relative_hour=1..3`: [Open-Meteo Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api)

取得したAPI応答を加工せず`response.json`の`sources.observation.response`と`sources.forecast.response`へ保存する。取得URL、取得時刻、基準時刻、地点、`run_id`、SHA-256を併記する。実APIのため`is_simulated`は`false`とする。

この予報は現在から見た未来予報ではなく、対象日付に対応する過去予報アーカイブである。
