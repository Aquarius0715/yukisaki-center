# 除雪車GPSシミュレーター

S3のcurated道路形状から決定的な巡回経路を作り、3台の仮想除雪車を道路上で走らせるDockerサービス。道路グラフを走行可能な道路でバックトラックしながら網羅し、3台の経路へ走行距離が均等になるよう分割する。5秒ごとにGPSイベントをEventBridgeカスタムバスへ送る。

- 実在車両ではなく、常に`is_simulated: true`
- デモ時刻は2026-01-23 12:00 JSTから進める
- 1 ECS Fargateタスク内で3台を管理
- 3台の経路の和集合で、curated道路に含まれる全道路区間を巡回
- PostgreSQLやS3へ直接書かない
- ECS ServiceのDesired Countはデプロイ時0

詳細なイベント契約は[docs/contract.md](docs/contract.md)を参照する。
