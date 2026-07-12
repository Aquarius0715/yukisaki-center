# AI作業指示

このサービスはS3 `raw/`を検証・正規化し、S3 `normalized/`と`curated/`を生成してからPostgreSQLへロードする。S3が正本であり、DBへの直接収集や、S3を経由しない更新は禁止する。失敗入力は削除せず`quarantine/`へ残す。
