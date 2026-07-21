#!/bin/sh
root="${1:-/app}"
test -f "$root/index.html"
test -f "$root/app.js"
test -f "$root/style.css"
grep -q "雪道ナビゲーション" "$root/index.html"
grep -q "モックデータ" "$root/index.html"
grep -q "mockData" "$root/app.js"
grep -q "Yukisaki Navigation App UI" "$root/index.html"
