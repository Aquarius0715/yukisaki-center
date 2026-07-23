# 設定

ポート、CORS許可元、データベース接続先の名前を管理する。接続文字列やトークンはコミットしない。

Apple Maps Server APIはSecrets Managerの`yukisaki/<environment>/api/apple-maps-server-api`を使用する。JSONキーは`team_id`、`key_id`、`private_key`とし、ブラウザ用MapKit JSトークンとは分離する。詳細は[Apple Maps地点検索API](../../../docs/guides/place-search-api.md)を参照する。
