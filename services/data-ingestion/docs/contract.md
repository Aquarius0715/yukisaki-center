# 入出力契約

入力は許可済みHTTPS取得元または固定fixture、出力はS3 `raw/{source}/{dataset}/ingest_date=.../run_id=.../`である。原本、取得メタデータ、manifestを別オブジェクトとして保存する。
