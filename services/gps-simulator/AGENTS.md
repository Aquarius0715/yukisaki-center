# AI作業指示

このサービスはデモ専用の除雪車GPS送信元である。実在車両を表さず、すべてのイベントに`is_simulated: true`、固定シナリオ日時、`run_id`を保持する。

道路形状はS3 `curated/road-segments/`から読み、道路上だけを走行する。1コンテナで3台を管理し、EventBridge以外へ直接送信・保存しない。デプロイ時のECS Desired Countは0とし、`env:start|stop`で起動・停止する。
