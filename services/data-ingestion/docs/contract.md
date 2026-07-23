# データ収集の共通入出力契約

## 原則

- 外部から取得した原本は、データ源ごとのS3バケットの`raw/`へ不変保存する。
- CollectorはPostgreSQLへ直接接続しない。
- PostgreSQLへのロードはS3 rawを入力とする`data-processing`だけが行う。
- Weatherと道路を含む全Collectorは、`data_ingestion.common.metadata`で共通メタデータを生成する。

## 共通メタデータ

| 項目 | 内容 |
|---|---|
| `metadata_schema_version` | 共通メタデータ契約のバージョン |
| `run_id` | 収集実行を一意に追跡するID |
| `dataset` | データセット名 |
| `fetched_at` | 外部データ取得完了時刻（UTC ISO 8601） |
| `target_start_at` | 対象期間の開始日時 |
| `target_end_at` | 対象期間の終了日時 |
| `source` | `open-meteo`、`openstreetmap`等の出典ID |
| `source_urls` | 実際に参照した取得元URL配列 |
| `checksum_sha256` | 主たるrawオブジェクトのSHA-256 |
| `is_simulated` | fixture・仮データの場合だけ`true` |

同じフィールドを`metadata.json`と`manifests/data-ingestion/{run_id}.json`へ保存する。S3オブジェクトメタデータにも`sha256`と`run-id`を設定する。

## S3キー

```text
raw/open-meteo/weather-window/event_date={date}/run_id={run_id}/...
raw/osm/road-network/ingest_date={date}/run_id={run_id}/...
raw/simulated/plow-gps/event_date={date}/hour={hour}/run_id={run_id}/events.jsonl
manifests/data-ingestion/{run_id}.json
```

## 基準時刻と地点

| 項目 | 値 |
|---|---|
| 基準時刻 | `2026-01-23T12:00:00+09:00` |
| 対象範囲 | 新潟県長岡市全域 |
| 市域bbox | `138.643056,37.176389,139.124444,37.710278` |
| 気象地点 | bbox内を約9km間隔で覆う5列×7行の35地点 |
| タイムゾーン | `Asia/Tokyo` |

## データ源

- `relative_hour=-3..0`: [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)
- `relative_hour=1..3`: [Open-Meteo Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api)

取得したAPI応答を加工せず`response.json`の`locations[].sources.observation.response`と`locations[].sources.forecast.response`へ保存する。取得URL、取得時刻、基準時刻、全地点、対象bbox、`run_id`、SHA-256を併記する。実APIのため`is_simulated`は`false`とする。

この予報は現在から見た未来予報ではなく、対象日付に対応する過去予報アーカイブである。

## 消雪パイプ仮データ

道路Collectorが最後に保存する`manifests/data-ingestion/{run_id}.json`を入力とし、道路GeoJSONの`road_name`（なければ`name`）が空でない区間を`snow_pipe=true`、`operation_status=active`とする。名前がない区間は`snow_pipe=false`、`operation_status=inactive`とする。これは設備実態を示すものではなく、必ず`source=simulated-road-name-rule`、`rule_version=road-name-active-v2`、`is_simulated=true`を保持する。出力は次へ不変保存する。

```text
raw/simulated/snow-pipe/scenario_date={date}/run_id={run_id}/snow_pipe.jsonl
```

この出力と対応するmetadata/manifestは道路入力バケットではなく、Snow Pipe専用データバケットへ保存する。

## 除雪車GPS仮データ

EventBridgeからSQSへ配信されたイベントを検証し、`vehicle_id`、対象時刻、実受信時刻、緯度経度、速度、方位、作業種別、`ground_truth_segment_id`をJSON Linesで不変保存する。常に`source=yukisaki-gps-simulator`、`is_simulated=true`であり、収集サービスからDBへ書かない。
