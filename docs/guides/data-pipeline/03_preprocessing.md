# 前処理手順

## 1. 処理順序

```text
OSM raw
  -> 車両通行道路の抽出
  -> 交差点で道路区間へ分割
  -> 方向・コスト用属性を生成
  -> segment_id生成
  -> 標高サンプリング
  -> 勾配計算
  -> road_segments curated

気象 raw
  -> 構文・値検証
  -> 単位・時刻正規化
  -> 観測点/区域の位置解決
  -> 道路区間へ空間結合

仮GPS raw
  -> 値検証・時系列整列
  -> マップマッチング
  -> 区間ごとの最終除雪時刻を集約
```

## 2. 道路区間生成

### 2.1 抽出

車両向け道路を対象とし、少なくとも次のOSM属性を保持する。

- `osm_way_id`
- `highway`
- `name`
- `oneway`
- `junction`
- `lanes`
- `maxspeed`
- `bridge`
- `tunnel`
- `access`と車両別access
- 元タグJSON

アクセス禁止、工事中、私道等の扱いは設定ファイルで明示する。不明属性を勝手に`false`にせずNULLとして保持し、必要なら道路種別の既定値を別列に適用する。

### 2.2 分割

1. 道路中心線の座標を正規化する。
2. 交差点、行き止まり、属性変化点で分割する。
3. 一方通行は許可方向だけ、双方向道路は方向別エッジを作る。
4. 自己交差、長さ0、重複形状を検出する。
5. 測地線長または地域に適した投影座標で`length_m`を計算する。
6. 安定した`segment_id`を生成する。

道路表示用LineStringと、経路探索用の方向付きedgeを分けてもよい。その場合は`road_segment_id`と`edge_id`を別にする。

### 2.3 品質検査

- `segment_id`が一意。
- geometryがvalidかつ空でない。
- `length_m > 0`。
- 方向付きedgeの始点・終点がnodeテーブルに存在する。
- AOI内の主要地点間に経路が存在する。
- 連結成分数と孤立edge数をレポートする。
- 道路種別別の件数・総延長を前回と比較する。

## 3. 標高・勾配

### 3.1 サンプリング

各区間を10～20m間隔でサンプリングし、始点・終点だけでなく区間内の最大勾配を計算する。短い区間も最低2点を持たせる。

### 3.2 計算

隣接サンプル`i`、`i+1`について次を計算する。

```text
gradient_percent = 100 * (elevation[i+1] - elevation[i]) / horizontal_distance_m
```

curated道路区間には少なくとも次を持たせる。

- `elevation_start_m`
- `elevation_end_m`
- `elevation_min_m`
- `elevation_max_m`
- `max_up_gradient_percent`
- `max_down_gradient_percent`
- `max_abs_gradient_percent`
- `elevation_source`
- `elevation_missing_ratio`

極端に短い点間距離、単独の標高スパイク、DEM境界をそのまま最大勾配にしない。最小距離、移動中央値等の補正ルールを設定ファイル化し、補正前の値も検査できるようにする。

橋梁・トンネルでは地表DEMと道路高が一致しない可能性がある。MVPでは勾配信頼度を下げるか、当該区間に`elevation_caveat`を付ける。

### 3.3 品質検査

- 標高欠損率。
- 道路区間ごとの有効サンプル数。
- 最大絶対勾配の分布。
- 異常閾値を超えた区間の一覧。
- DEMソース別の件数。

異常値を黙って削除せず、quarantineまたは品質レポートへ残す。

## 4. 気象の正規化と道路への結合

### 4.1 正規化

- JST表記を解釈した後、UTCのタイムゾーン付き時刻へ変換する。
- 気温は℃、降水量はmm、降雪・積雪はcm、風速はm/sへ統一する。
- `0`と欠測を区別する。
- 品質コード、速報・確定等の状態があれば保持する。
- 発表時刻、対象時刻、取得時刻を別々に保持する。

### 4.2 空間結合

MVPでは道路区間の中点から最寄り観測点までの距離を計算し、設定した最大距離内だけを結合する。予報・警報が区域データなら区域ポリゴンとの包含関係で結合する。

```text
segment_weather(
  segment_id,
  weather_record_id,
  relation_type,
  distance_m,
  valid_from,
  valid_to,
  joined_at
)
```

距離が遠いことは危険を意味しない。`confidence`を下げ、「情報不足」と判定するための根拠にする。

### 4.3 時間窓

走りやすさ指数に必要な次の派生値を、前処理または指数計算直前に作る。

- 過去1時間降雪量
- 過去3時間降雪量
- 最新積雪深
- 今後1時間予測値
- 最終正常取得からの経過時間

時間窓はイベント時刻を基準にする。処理時刻を観測時刻の代わりに使わない。

## 5. 消雪パイプ

入力された`segment_id`を道路マスターへ外部キー検査する。最新状態とは別に履歴を残す。

```text
snow_pipe_history(
  segment_id,
  snow_pipe,
  operation_status,
  effectiveness,
  valid_from,
  ingested_at,
  is_simulated
)
```

将来の実データへ置換できるよう、仮データ固有の列名や処理分岐を下流へ広げず、`source`と`is_simulated`で区別する。

## 6. 除雪車GPSのマップマッチング

### 6.1 MVP方式

1. 車両ごとに時刻順へ並べる。
2. 明らかな重複点・異常速度を除外ではなくフラグ付けする。
3. 各点から候補道路を検索半径内で取得する。
4. 距離、道路方向と進行方位の差、直前候補との接続性で候補を評価する。
5. 閾値を満たさない点は`unmatched`とする。
6. `operation = snow_removal`等の対象点だけを除雪実績へ反映する。
7. 区間ごとに`last_plowed_at`と時間窓内の通過回数を集約する。

最近傍道路だけで確定すると、並行道路・高架・橋梁で誤結合しやすい。デモであっても進行方向と時系列接続性を含める。

### 6.2 出力

```text
plow_map_match(
  vehicle_id,
  gps_timestamp,
  segment_id,
  distance_m,
  heading_difference_deg,
  match_score,
  match_status,
  operation,
  is_simulated
)
```

## 7. PostGISへのロード

1. S3 curatedをステージングテーブルへCOPYする。
2. 件数、NULL、一意性、geometry、外部キーを検査する。
3. 検査に失敗したら本テーブルを更新しない。
4. 1トランザクションでUPSERTする。
5. ロードした`run_id`と件数を管理テーブルへ記録する。
6. 成功後にだけ`latest`ポインタを更新する。

RDS for PostgreSQLでは利用可能な拡張がエンジン版で異なるため、作成前とアップグレード前に[AWSの対応拡張一覧](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.Extensions.html)を確認する。DB上でも`SHOW rds.extensions;`でPostGISとpgRoutingの対応を確認する。

## 8. 前処理の完了条件

- 固定したraw入力から同一のcurated出力を再生成できる。
- 全curatedレコードを`run_id`からrawまで追跡できる。
- 道路区間IDが再実行で変わらない。
- 欠測と0を区別できる。
- AOI内のデモ地点間で道路グラフが接続している。
- 勾配異常とGPS未結合を品質レポートで確認できる。
- 仮データが全経路で`is_simulated: true`になる。
