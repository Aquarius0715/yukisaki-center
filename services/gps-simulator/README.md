# 除雪車GPSシミュレーター

S3のcurated道路形状から決定的な周回経路を作り、3台の仮想除雪車を道路上で走らせるDockerサービス。5秒ごとにGPSイベントをEventBridgeカスタムバスへ送る。

- 実在車両ではなく、常に`is_simulated: true`
- デモ時刻は2026-01-23 12:00 JSTから進める
- 1 ECS Fargateタスク内で3台を管理
- PostgreSQLやS3へ直接書かない
- ECS ServiceのDesired Countはデプロイ時0

詳細なイベント契約は[docs/contract.md](docs/contract.md)を参照する。
