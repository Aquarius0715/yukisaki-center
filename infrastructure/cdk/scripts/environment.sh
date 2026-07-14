#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
if [[ -z "${ACTION}" ]]; then
  echo "Usage: $0 <start|stop|status> [--profile PROFILE] [--region REGION] [--data-stack STACK] [--road-stack STACK]" >&2
  exit 2
fi
shift

PROFILE="${AWS_PROFILE:-yukisaki-dev}"
REGION="${AWS_REGION:-ap-northeast-1}"
STACK_NAME="${STACK_NAME:-YukisakiDataPipeline-dev}"
ROAD_STACK_NAME="${ROAD_STACK_NAME:-YukisakiRoadCollector-dev}"

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
    --data-stack)
      STACK_NAME="$2"
      shift 2
      ;;
    --road-stack)
      ROAD_STACK_NAME="$2"
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
  local stack_name="$1"
  local output_key="$2"
  aws_cli cloudformation describe-stacks \
    --stack-name "${stack_name}" \
    --query "Stacks[0].Outputs[?OutputKey=='${output_key}'].OutputValue | [0]" \
    --output text
}

DATABASE_ID="$(stack_output "${STACK_NAME}" DatabaseIdentifier)"
COLLECTOR_FUNCTION="$(stack_output "${STACK_NAME}" CollectorFunctionName)"
LOADER_FUNCTION="$(stack_output "${STACK_NAME}" LoaderFunctionName)"
WEATHER_SCHEDULE="$(stack_output "${STACK_NAME}" WeatherScheduleName)"
ROAD_SCHEDULE="$(stack_output "${ROAD_STACK_NAME}" RoadScheduleName)"

if [[ "${DATABASE_ID}" == "None" || "${COLLECTOR_FUNCTION}" == "None" || "${LOADER_FUNCTION}" == "None" || "${WEATHER_SCHEDULE}" == "None" || "${ROAD_SCHEDULE}" == "None" ]]; then
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

schedule_state() {
  aws_cli events describe-rule --name "$1" --query 'State' --output text
}

enable_schedule() {
  aws_cli events enable-rule --name "$1" >/dev/null
}

disable_schedule() {
  aws_cli events disable-rule --name "$1" >/dev/null
}

case "${ACTION}" in
  status)
    echo "dataStack=${STACK_NAME}"
    echo "roadStack=${ROAD_STACK_NAME}"
    echo "database=${DATABASE_ID} status=$(database_status)"
    echo "collector=${COLLECTOR_FUNCTION} state=$(function_state "${COLLECTOR_FUNCTION}")"
    echo "loader=${LOADER_FUNCTION} state=$(function_state "${LOADER_FUNCTION}")"
    echo "weatherSchedule=${WEATHER_SCHEDULE} state=$(schedule_state "${WEATHER_SCHEDULE}")"
    echo "roadSchedule=${ROAD_SCHEDULE} state=$(schedule_state "${ROAD_SCHEDULE}")"
    ;;
  stop)
    disable_schedule "${WEATHER_SCHEDULE}"
    disable_schedule "${ROAD_SCHEDULE}"
    pause_function "${COLLECTOR_FUNCTION}"
    pause_function "${LOADER_FUNCTION}"
    status="$(database_status)"
    if [[ "${status}" == "available" ]]; then
      aws_cli rds stop-db-instance --db-instance-identifier "${DATABASE_ID}" >/dev/null
      echo "Stop requested for ${DATABASE_ID}. Collection schedules are disabled and Lambda execution is paused."
    elif [[ "${status}" == "stopped" || "${status}" == "stopping" ]]; then
      echo "Database is already ${status}. Collection schedules are disabled and Lambda execution is paused."
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
    enable_schedule "${WEATHER_SCHEDULE}"
    enable_schedule "${ROAD_SCHEDULE}"
    echo "Database is available. Lambda execution and collection schedules are enabled."
    ;;
  *)
    echo "Unknown action: ${ACTION}" >&2
    exit 2
    ;;
esac
