# Webから利用する地図API契約

外部契約の正本はリポジトリの `docs/architecture/map-api-design.md` と `services/api/docs/contract.md`。Web実装型は `src/api/contracts.ts`、外部GeoJSONから画面内部型への変換は `src/api/mapApiAdapter.ts` に置く。Webは指数・危険理由を再計算しない。

## Map API

| Method | Path | Webでの用途 |
|---|---|---|
| GET | `/healthz` | LambdaのLiveness確認 |
| GET | `/v1/map/snapshot?bbox=west,south,east,north&limit=3000&view=map` | 初回の軽量道路・除雪車一括取得 |
| GET | `/v1/road-segments?bbox=...&limit=1500&view=map&min_road_rank=0..6` | 地図用の軽量道路エンドポイント |
| GET | `/v1/road-segments/{id}` | 道路区間1件 |
| GET | `/v1/snowplows` | 初回後、5秒間隔の最新位置取得 |
| GET | `/v1/places/autocomplete?q=...` | Apple Mapsによる入力補完 |
| GET | `/v1/places/search?q=...` | 選択した文字列を長岡市内の座標候補へ変換 |
| POST | `/v1/routes` | 確定した出発地・目的地とモードから最大3経路を取得 |
| POST | `/v1/ai/explain-routes` | 経路APIが確定した候補を比較説明 |
| POST | `/v1/ai/explain-danger-points` | 経路APIが抽出した注意箇所を説明 |

初回snapshotは `schema_version`, `data_timestamp`, `confidence`, `is_simulated`, `demo`, `roads`, `snowplows` を返す。道路はLineStringまたはMultiLineStringとし、一覧では指数と消雪パイプを、詳細では`score_factors`、`last_plowed_at`等を画面へ反映する。

地図一覧の`view=map`はFeatureごとにGeometry、`segment_id`、`road_name`、`road_type`、`drivability_score`、`snow_pipe`、`snow_pipe_operation_status`だけを受け取る。時刻・信頼度・仮データ区分はコレクションのメタデータを使う。指数根拠、勾配、延長、消雪効果、最終除雪情報は道路タップ後の`/v1/road-segments/{id}`で取得し、取得中は詳細シートへローディング状態を表示する。

初期表示ではIndexedDBに保存した表示範囲があれば道路を先に復元し、並行して`/healthz`とsnapshotを取得する。その後は表示範囲ごとに道路APIを取得し、道路選択時は詳細APIから最新の1件を取得し直す。最大スパン0.04度以下の近距離表示でも最大6個の固定空間タイルを使い、最大2リクエストずつ取得する。1ページ1,500区間を先に描画し、300ミリ秒の間隔を空けながら`next_cursor`を追跡して合計最大18,000区間まで補完する。広域表示でも最大6空間タイルを使い、縮尺に応じた`min_road_rank`をAPIへ渡して道路種別を絞ってからページングする。先頭ページは受信時点で描画し、固定タイルのbbox、道路ランク、cursorをCloudFrontの共有キャッシュキーにする。

MapKitへは現在の表示範囲の道路だけを描画する。近距離では全道路種別を対象とし、広げるにつれて`tertiary`以上、`primary`以上、`trunk`以上、`motorway`の順に道路種別を絞る。縮尺別のページ数は実データ上の対象道路が各固定タイルで完了する値にし、ページ上限位置で道路を切らない。同色かつ同一道路名・道路種別の区間は縮尺別の接続許容距離で連結してオーバーレイ数を抑える。広域でデータが途切れた同一道路名の間は中立色の連続性ガイドだけを下層へ描き、未取得区間の走りやすさ指数を推測しない。地図移動時は古いリクエストを中断し、新しい表示範囲の道路へ差し替える。Apple MapKit JSへは表示中のレイヤーだけを生成し、詳細な根拠オブジェクトを複製しない。除雪車のアニメーションは毎秒5回以下で座標を更新し、補間完了後は描画ループを停止する。詳細の根拠はReact側に保持する。

除雪車はPoint GeoJSONで、`vehicle_id`をマーカーキー、`matched_segment_id`を道路との関連キー、`heading_degrees`をアイコンの向きに使う。新しい位置は実受信時刻を表す`data_timestamp`で判定し、未提供の場合だけ`observed_at`へフォールバックする。これにより、固定デモ時刻へ戻るシミュレーター再起動後も直ちに新しい位置へ更新する。

地図の移動・拡大縮小が終わると、750ミリ秒のデバウンス後に現在の表示範囲を道路タイルへ変換して再取得する。取得中に別の表示範囲へ移動した場合はサーバーリクエストを重ねず、進行中の取得が完了してから最新範囲だけを取得する。古い結果は画面へ反映しない。`truncated: true`は内部で道路上限到達として保持するが、固定警告は表示せず、利用者が地図を拡大すると自動的に対象範囲を狭めて再取得する。`is_simulated: true`はデモデータとして画面に明示する。503または429では最後の正常値を保持し、「更新停止」を表示して値を推定しない。

道路表示キャッシュはメモリ内の近距離4件・広域タイル32件に加え、IndexedDBへ最大12表示範囲を24時間保持する。メモリ上の道路は60秒間を新鮮と扱い、定期更新でも新鮮なキャッシュを強制的に無視しない。IndexedDBは再読み込み直後の先行表示に使い、その後API結果で更新する。書き込みは短時間に連続するページ描画をまとめて行う。AWS配信では道路一覧・道路詳細・snapshotをCloudFrontで90秒共有キャッシュし、除雪車はキャッシュしない。

道路描画は道路・レイヤーごとの安定キーと表示シグネチャを保持する。段階取得で道路が追加されたときは、変更のないMapKit Overlayを維持し、追加・更新・削除されたOverlayだけを反映する。

## 地点・経路・AI

地点入力は`autocomplete -> search`の順に解決し、利用者が確定した座標だけを`/v1/routes`へ渡す。自然言語条件抽出はWeb画面へ公開せず、「AIに相談」入口も表示しない。

経路順位・指数・危険区間はWebで再計算しない。AI比較・危険説明は経路APIの成功レスポンスに対してのみ呼び出し、AIに順位や危険区間を変更させない。

`VITE_DATA_MODE=api`では道路一覧・snapshot、地点検索、経路探索、AI APIの失敗を固定モックへ置き換えない。道路更新失敗時は最後の実API値またはキャッシュを維持する。除雪車の表示用フォールバックと、公開気象APIが未実装のための固定天気表示だけは、`VITE_ENABLE_MOCK_FALLBACK=true`の場合にモックを使用する。走行軌跡・本日走行距離は公開APIに含まれない。

## エラー

```json
{ "error": { "code": "service_unavailable", "message": "safe public message" } }
```

400は入力不正、404は対象なし、405はGET以外、503はRDS停止または一時障害。内部例外、DB接続情報、Secret ARNは表示しない。
