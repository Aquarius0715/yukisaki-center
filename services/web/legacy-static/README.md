# 旧静的Web版

React/Vite版へ移行する前のHTML、CSS、JavaScriptと検証・配備スクリプトを、復元可能な形で退避しています。現在のアプリの起動、ビルド、配備では使用しません。

旧 `aws-site` スクリプトはS3バケットを公開設定にするため、参照専用です。現在はCloudFront Origin Access Controlと非公開S3を前提にしたルートの `scripts/deploy-aws.mjs` を使用します。
