#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-yukisaki-dev}"
REGION="${AWS_REGION:-ap-northeast-1}"
DATA_STACK_NAME="${DATA_STACK_NAME:-YukisakiDataPipeline-dev}"
GPS_STACK_NAME="${GPS_STACK_NAME:-YukisakiGpsPipeline-dev}"
DATA_TIMESTAMP="${TARGET_REFERENCE_TIME:-2026-01-23T12:00:00+09:00}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --data-stack)
      DATA_STACK_NAME="$2"
      shift 2
      ;;
    --gps-stack)
      GPS_STACK_NAME="$2"
      shift 2
      ;;
    --data-timestamp)
      DATA_TIMESTAMP="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! "${DATA_TIMESTAMP}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$ ]]; then
  echo "--data-timestamp must be an ISO 8601 timestamp with timezone." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_CLI="${SCRIPT_DIR}/aws-docker.sh"

aws_cli() {
  bash "${AWS_CLI}" "$@" --profile "${PROFILE}" --region "${REGION}"
}

stack_output() {
  local stack_name="$1"
  local output_key="$2"
  aws_cli cloudformation describe-stacks \
    --stack-name "${stack_name}" \
    --query "Stacks[0].Outputs[?OutputKey=='${output_key}'].OutputValue | [0]" \
    --output text
}

DATABASE_ID="$(stack_output "${DATA_STACK_NAME}" DatabaseIdentifier)"
SCORER_FUNCTION="$(stack_output "${GPS_STACK_NAME}" DrivabilityScorerFunctionName)"
DATABASE_STATUS="$(aws_cli rds describe-db-instances \
  --db-instance-identifier "${DATABASE_ID}" \
  --query 'DBInstances[0].DBInstanceStatus' \
  --output text)"

if [[ "${DATABASE_STATUS}" != "available" ]]; then
  echo "Database ${DATABASE_ID} is ${DATABASE_STATUS}. Run npm run env:start first." >&2
  exit 1
fi

CONCURRENCY="$(aws_cli lambda get-function-concurrency \
  --function-name "${SCORER_FUNCTION}" \
  --query 'ReservedConcurrentExecutions' \
  --output text)"
if [[ "${CONCURRENCY}" == "0" ]]; then
  echo "Scorer ${SCORER_FUNCTION} is paused. Run npm run env:start first." >&2
  exit 1
fi

PAYLOAD="{\"action\":\"score_all\",\"dataTimestamp\":\"${DATA_TIMESTAMP}\"}"
echo "Scoring every road segment at ${DATA_TIMESTAMP} with ${SCORER_FUNCTION}..."
aws_cli lambda invoke \
  --function-name "${SCORER_FUNCTION}" \
  --invocation-type RequestResponse \
  --cli-binary-format raw-in-base64-out \
  --payload "${PAYLOAD}" \
  --log-type Tail \
  /dev/stdout
