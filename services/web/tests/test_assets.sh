#!/bin/sh
root="${1:-/app}"
test -f "$root/index.html"
test -f "$root/app.js"
