#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-help}"
BUCKET="${2:-}"

if [[ "$MODE" == "help" || "$MODE" == "-h" || "$MODE" == "--help" ]]; then
  echo "Usage: bash scripts/aws-site.sh on <bucket-name>"
  echo "       bash scripts/aws-site.sh off <bucket-name>"
  exit 0
fi

if [[ -z "$BUCKET" ]]; then
  echo "Bucket name is required." >&2
  exit 1
fi

if [[ "$MODE" == "on" ]]; then
  echo "Enabling static site hosting for s3://$BUCKET"
  aws s3 website "s3://$BUCKET" --index-document index.html --error-document index.html >/dev/null
  aws s3api put-bucket-policy --bucket "$BUCKET" --policy '{"Version":"2012-10-17","Statement":[{"Sid":"PublicReadGetObject","Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::'"$BUCKET"'/*"}]}' >/dev/null
  echo "AWS static site hosting is ON."
elif [[ "$MODE" == "off" ]]; then
  echo "Disabling public site hosting for s3://$BUCKET"
  aws s3api delete-bucket-policy --bucket "$BUCKET" >/dev/null
  echo "AWS static site hosting is OFF."
else
  echo "Unknown mode: $MODE" >&2
  exit 1
fi
