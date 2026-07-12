# データ収集手順

## 1. 収集前に決めること

### 1.1 対象範囲

長岡市全域をいきなり対象にせず、最初はデモ経路を含む小さなAOI（Area of Interest）をGeoJSONで作る。

```text
config/aoi/nagaoka-mvp.geojson
```

AOIには次を記録する。

- 名前と版
- 作成日時
- PolygonまたはMultiPolygon
- 想定する出発地・目的地
- バッファ距離。経路がAOI境界で切れないよう数km程度を検討する

### 1.2 データ台帳

データごとに取得前に以下を台帳化する。

| 項目 | 例 |
|---|---|
| 所有・提供者 | 気象庁 |
| 取得URL | 実際に使用するURL |
| 利用規約URL | 規約・帰属表示の根拠 |
| 機械取得可否 | 確認済み / 要確認 |
| 更新頻度 | 10分、1時間、随時等 |
| 形式 | XML、PBF、PNG等 |
| タイムゾーン | JST、UTC |
| 欠測表現 | NULL、`e`、特定値等 |
| 再配布条件 | 表示条件、ODbL等 |
| 最終確認日 | YYYY-MM-DD |

ブラウザで見えるページの内部APIを、提供仕様がないまま本番依存先にしない。

## 2. 道路ネットワーク

### 2.1 初期取込

1. OpenStreetMapのPBF形式の地域抽出データを用意する。
2. 取得URL、取得日時、ファイルサイズ、SHA-256をmanifestへ記録する。
3. 原本を`raw/osm/road-network/...`へ保存する。
4. AOIで切り出す。ただし経路接続性のため、AOIにバッファを付ける。
5. 車両通行対象となる`highway`を抽出する。
6. OSMの帰属表示とODbLへの対応をデータ台帳へ記録する。

大きな抽出や反復取得で公開Overpass APIへ負荷をかけず、MVPの初期取込は地域PBFを基本とする。OpenStreetMapデータはODbLで提供され、帰属表示が必要である。詳細は[OpenStreetMapのCopyright and License](https://www.openstreetmap.org/copyright/attribution-guide/)を確認する。

### 2.2 取得時の検証

- ファイルが0 byteでない。
- PBFをパーサーで開ける。
- AOIと道路の交差件数が1件以上ある。
- `highway`種別別件数が前回から大幅に変化していない。
- `oneway`、`bridge`、`tunnel`等の主要属性が抽出できる。

## 3. 標高

### 3.1 取得方式

道路点ごとに試験提供APIを大量呼び出しするのではなく、AOIを覆う国土地理院の標高タイルを一度取得してS3へキャッシュし、そのタイルから標高を引く。

国土地理院の標高タイルにはテキストとPNGがあり、同じタイル・ピクセル座標を使用する。[標高タイルの詳細仕様](https://maps.gsi.go.jp/development/demtile.html)に従ってデコードする。利用可能なDEMとURL、必要な出典表示は[地理院タイル一覧](https://maps.gsi.go.jp/development/index.html)で確認する。

### 3.2 手順

1. 道路形状を一定間隔でサンプリングする。初期値は10～20mを目安とする。
2. 各点をWeb Mercatorのタイル座標とピクセル座標へ変換する。
3. 必要なタイルの集合を重複排除する。
4. 同時接続数と再試行間隔を抑えてタイルを取得する。
5. HTTPヘッダー、取得日時、SHA-256とともに`raw/gsi/elevation-tile/...`へ保存する。
6. 高精度なDEMから順に参照し、欠測なら次のDEMへフォールバックする。
7. 標高値とともに`elevation_source`、`tile_z/x/y`を保存する。

標高タイルは地表面に基づくため、橋梁や高架そのものの高さを表さない場合がある。局所的な切土・盛土でも実道路勾配とずれる可能性があるため、結果を実測値として扱わない。

## 4. 気象

### 4.1 MVPでの扱い

気象庁は防災情報XMLのPULL型提供を案内している。対象電文、更新頻度、XMLコードは[気象データ高度利用ポータル](https://www.data.jma.go.jp/developer/)と情報カタログで確認する。

一方、Webページ内部で使用される未文書化JSONエンドポイントは変更される可能性がある。観測値として利用する場合は、機械取得・二次利用・更新保証を個別に確認し、`source_adapter`で交換可能にする。確認が終わるまでは固定fixtureまたは明示的な仮データでパイプラインを作る。

### 4.2 Collectorの手順

1. Schedulerから`dataset`、`scheduled_at`を受け取る。Step Functions等から`run_id`が渡されなければCollectorでUUIDを発行する。
2. 接続・読取タイムアウトを指定して取得する。
3. HTTPステータス、Content-Type、ETag、Last-Modifiedを記録する。
4. XML/JSONを変更せずS3 rawへ保存する。
5. SHA-256が直前と同じでも取得履歴はmanifestへ記録する。Schedulerの再試行は同じ論理実行として判定できる冪等キーも記録する。
6. 最小限の構文検証を行う。
7. 成功イベントを後段へ渡す。失敗時はnormalizedを更新しない。

### 4.3 正規化する最小項目

```text
weather_record_id
station_or_area_code
latitude
longitude
data_timestamp
temperature_c
precipitation_mm
snowfall_cm
snow_depth_cm
wind_speed_ms
wind_direction_deg
forecast_horizon_minutes
quality_code
fetched_at
source
source_url
schema_version
```

観測、予報、警報・注意報は意味と粒度が異なるため、同じテーブルへ無理に押し込まない。

## 5. 消雪パイプ仮データ

CSVまたはJSON Linesで次を受け付ける。

```csv
segment_id,snow_pipe,operation_status,effectiveness,updated_at,is_simulated
segment_example,true,active,0.8,2026-07-12T00:00:00Z,true
```

検証規則:

- `segment_id`がcurated道路区間に存在する。
- `operation_status`は`active|inactive|unknown`のみ。
- `effectiveness`は0.0～1.0。
- `updated_at`はタイムゾーン付きISO 8601。
- `is_simulated`は常に`true`。

## 6. 除雪車GPS仮データ

APIまたはS3投入の内部形式をJSON Linesへ統一する。

```json
{"vehicle_id":"mock-001","timestamp":"2026-07-12T00:00:00Z","latitude":37.0,"longitude":138.8,"speed_kmh":15.0,"operation":"snow_removal","is_simulated":true}
```

検証規則:

- 緯度は-90～90、経度は-180～180。
- `timestamp`は未来に大きくずれていない。
- 同一車両で時刻が極端に逆行しない。
- `speed_kmh`は0以上で、異常な値はquarantineへ送る。
- `operation`は許可値一覧で検証する。
- AOIから離れた点は削除せず、理由付きでquarantineへ送る。

## 7. Collector共通のテスト

- 正常レスポンスをrawへ保存できる。
- タイムアウト、5xx、429で指数バックオフ付き再試行を行う。
- 4xxや形式違反を無限再試行しない。
- XML/JSONの仕様変更を検出し、既存normalizedを上書きしない。
- 同一イベントの再実行で重複レコードを作らない。
- ログへ秘密値や巨大な原文全体を出さない。
