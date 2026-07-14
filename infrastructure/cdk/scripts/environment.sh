#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
if [[ -z "${ACTION}" ]]; then
  echo "Usage: $0 <start|stop|status> [--profile PROFILE] [--region REGION] [--stack STACK_NAME]" >&2
  exit 2
fi
shift

PROFILE="${AWS_PROFILE:-yukisaki-dev}"
REGION="${AWS_REGION:-ap-northeast-1}"
STACK_NAME="${STACK_NAME:-YukisakiDataPipeline-dev}"

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
    --stack)
      STACK_NAME="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_CLI="${SCRIPT_DIR}/aws-docker.sh"

aws_cli() {
  bash "${AWS_CLI}" "$@" --profile "${PROFILE}" --region "${REGION}"
}

stack_output() {
  local output_key="$1"
  aws_cli cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='${output_key}'].OutputValue | [0]" \
    --output text
}

DATABASE_ID="$(stack_output DatabaseIdentifier)"
COLLECTOR_FUNCTION="$(stack_output CollectorFunctionName)"
LOADER_FUNCTION="$(stack_output LoaderFunctionName)"

if [[ "${DATABASE_ID}" == "None" || "${COLLECTOR_FUNCTION}" == "None" || "${LOADER_FUNCTION}" == "None" ]]; then
  echo "Required CloudFormation outputs are missing. Deploy the latest CDK stack first." >&2
  exit 1
fi

database_status() {
  aws_cli rds describe-db-instances \
    --db-instance-identifier "${DATABASE_ID}" \
    --query 'DBInstances[0].DBInstanceStatus' \
    --output text
}

pause_function() {
  aws_cli lambda put-function-concurrency \
    --function-name "$1" \
    --reserved-concurrent-executions 0 >/dev/null
}

resume_function() {
  aws_cli lambda delete-function-concurrency --function-name "$1" >/dev/null
}

function_state() {
  local concurrency
  concurrency="$(
    aws_cli lambda get-function-concurrency \
      --function-name "$1" \
      --query 'ReservedConcurrentExecutions' \
      --output text
  )"
  if [[ "${concurrency}" == "None" ]]; then
    echo "enabled"
  elif [[ "${concurrency}" == "0" ]]; then
    echo "paused"
  else
    echo "enabled(reservedConcurrency=${concurrency})"
  fi
}

case "${ACTION}" in
  status)
    echo "stack=${STACK_NAME}"
    echo "database=${DATABASE_ID} status=$(database_status)"
    echo "collector=${COLLECTOR_FUNCTION} state=$(function_state "${COLLECTOR_FUNCTION}")"
    echo "loader=${LOADER_FUNCTION} state=$(function_state "${LOADER_FUNCTION}")"
    ;;
  stop)
    pause_function "${COLLECTOR_FUNCTION}"
    pause_function "${LOADER_FUNCTION}"
    status="$(database_status)"
    if [[ "${status}" == "available" ]]; then
      aws_cli rds stop-db-instance --db-instance-identifier "${DATABASE_ID}" >/dev/null
      echo "Stop requested for ${DATABASE_ID}. Lambda execution is paused."
    elif [[ "${status}" == "stopped" || "${status}" == "stopping" ]]; then
      echo "Database is already ${status}. Lambda execution is paused."
    else
      echo "Database is ${status}; Lambda execution is paused, but the database was not changed." >&2
      exit 1
    fi
    ;;
  start)
    status="$(database_status)"
    if [[ "${status}" == "stopped" ]]; then
      aws_cli rds start-db-instance --db-instance-identifier "${DATABASE_ID}" >/dev/null
    elif [[ "${status}" != "available" && "${status}" != "starting" ]]; then
      echo "Database is ${status}; wait until it becomes stopped or available." >&2
      exit 1
    fi
    if [[ "${status}" != "available" ]]; then
      echo "Waiting for ${DATABASE_ID} to become available..."
      aws_cli rds wait db-instance-available --db-instance-identifier "${DATABASE_ID}"
    fi
    resume_function "${COLLECTOR_FUNCTION}"
    resume_function "${LOADER_FUNCTION}"
    echo "Database is available. Lambda execution is enabled."
    ;;
  *)
    echo "Unknown action: ${ACTION}" >&2
    exit 2
    ;;
esac
