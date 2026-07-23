# ローカル経路マップビューア

AWSの`POST /v1/routes`をブラウザから呼び出し、最大3候補、スナップ地点、危険区間をOpenStreetMap上に表示する診断用ツールである。プロダクトの`services/web`とは独立しており、成果物へ組み込まない。

リポジトリルートで起動する。

```bash
docker compose -f infrastructure/compose/docker-compose.yml up route-viewer --build
```

Chromeで`http://localhost:4173`を開き、API URLと条件を入力して「APIから経路を取得」を押す。`http://localhost:4173/?sample=1`を開くと表示確認用デモJSONを自動描画する。

APIが利用できない場合は「デモJSONを表示」で、明示的に`is_simulated=true`とした表示確認用fixtureを描画できる。`curl`で保存した正常レスポンスを「保存済みJSONを表示する」へ貼り付けることもできる。

終了は`Ctrl+C`。バックグラウンド起動した場合は次で停止する。

```bash
docker compose -f infrastructure/compose/docker-compose.yml stop route-viewer
```

地図タイルは国土地理院からローカルNginx経由で取得・一時キャッシュし、Leafletは外部CDNから読み込むため、初回表示時はローカル端末にインターネット接続が必要である。APIキーやMapKitトークンは使用しない。
