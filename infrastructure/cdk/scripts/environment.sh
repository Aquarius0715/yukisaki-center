#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
if [[ -z "${ACTION}" ]]; then
  echo "Usage: $0 <start|stop|status> [--profile PROFILE] [--region REGION] [--data-stack STACK] [--road-stack STACK] [--snow-stack STACK]" >&2
  exit 2
fi
shift

PROFILE="${AWS_PROFILE:-yukisaki-dev}"
REGION="${AWS_REGION:-ap-northeast-1}"
STACK_NAME="${STACK_NAME:-YukisakiDataPipeline-dev}"
ROAD_STACK_NAME="${ROAD_STACK_NAME:-YukisakiRoadCollector-dev}"
SNOW_STACK_NAME="${SNOW_STACK_NAME:-YukisakiSnowPipePipeline-dev}"

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
    --stack|--data-stack)
      STACK_NAME="$2"
      shift 2
      ;;
    --road-stack)
      ROAD_STACK_NAME="$2"
      shift 2
      ;;
    --snow-stack)
      SNOW_STACK_NAME="$2"
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
ROAD_CLUSTER="$(stack_output "${ROAD_STACK_NAME}" RoadClusterName)"
SNOW_DATABASE_ID="$(stack_output "${SNOW_STACK_NAME}" MapSnowPipeDatabaseIdentifier)"
SNOW_LOADER_FUNCTION="$(stack_output "${SNOW_STACK_NAME}" RoadDatabaseLoaderFunctionName)"
SNOW_MANIFEST_RULE="$(stack_output "${SNOW_STACK_NAME}" SnowPipeManifestRuleName)"

for required_output in \
  "${DATABASE_ID}" "${COLLECTOR_FUNCTION}" "${LOADER_FUNCTION}" "${WEATHER_SCHEDULE}" \
  "${ROAD_SCHEDULE}" "${ROAD_CLUSTER}" "${SNOW_DATABASE_ID}" "${SNOW_LOADER_FUNCTION}" \
  "${SNOW_MANIFEST_RULE}"; do
  if [[ "${required_output}" == "None" || -z "${required_output}" ]]; then
    echo "Required CloudFormation outputs are missing. Deploy all latest CDK stacks first." >&2
    exit 1
  fi
done

database_status() {
  aws_cli rds describe-db-instances \
    --db-instance-identifier "$1" \
    --query 'DBInstances[0].DBInstanceStatus' \
    --output text
}

request_database_start() {
  local database_id="$1"
  local status
  status="$(database_status "${database_id}")"
  case "${status}" in
    available|starting)
      ;;
    stopped)
      aws_cli rds start-db-instance --db-instance-identifier "${database_id}" >/dev/null
      ;;
    *)
      echo "Database ${database_id} is ${status}; wait until it becomes stopped or available." >&2
      return 1
      ;;
  esac
}

wait_for_database() {
  local database_id="$1"
  if [[ "$(database_status "${database_id}")" != "available" ]]; then
    echo "Waiting for ${database_id} to become available..."
    aws_cli rds wait db-instance-available --db-instance-identifier "${database_id}"
  fi
}

request_database_stop() {
  local database_id="$1"
  local status
  status="$(database_status "${database_id}")"
  case "${status}" in
    available)
      aws_cli rds stop-db-instance --db-instance-identifier "${database_id}" >/dev/null
      echo "Stop requested for database ${database_id}."
      ;;
    stopped|stopping)
      echo "Database ${database_id} is already ${status}."
      ;;
    *)
      echo "Database ${database_id} is ${status}; it was not changed." >&2
      return 1
      ;;
  esac
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

rule_state() {
  aws_cli events describe-rule --name "$1" --query 'State' --output text
}

enable_rule() {
  aws_cli events enable-rule --name "$1" >/dev/null
}

disable_rule() {
  aws_cli events disable-rule --name "$1" >/dev/null
}

road_running_task_count() {
  aws_cli ecs list-tasks \
    --cluster "${ROAD_CLUSTER}" \
    --desired-status RUNNING \
    --query 'length(taskArns)' \
    --output text
}

stop_road_tasks() {
  local task_arns
  local stopped=0
  task_arns="$(
    aws_cli ecs list-tasks \
      --cluster "${ROAD_CLUSTER}" \
      --desired-status RUNNING \
      --query 'taskArns' \
      --output text
  )"
  if [[ -z "${task_arns}" || "${task_arns}" == "None" ]]; then
    echo "No running road Fargate tasks."
    return
  fi
  for task_arn in ${task_arns}; do
    aws_cli ecs stop-task \
      --cluster "${ROAD_CLUSTER}" \
      --task "${task_arn}" \
      --reason "yukisaki env:stop" >/dev/null
    stopped=$((stopped + 1))
  done
  echo "Stop requested for ${stopped} road Fargate task(s)."
}

case "${ACTION}" in
  status)
    echo "dataStack=${STACK_NAME}"
    echo "roadStack=${ROAD_STACK_NAME}"
    echo "snowStack=${SNOW_STACK_NAME}"
    echo "database=${DATABASE_ID} status=$(database_status "${DATABASE_ID}")"
    echo "snowDatabase=${SNOW_DATABASE_ID} status=$(database_status "${SNOW_DATABASE_ID}")"
    echo "collector=${COLLECTOR_FUNCTION} state=$(function_state "${COLLECTOR_FUNCTION}")"
    echo "loader=${LOADER_FUNCTION} state=$(function_state "${LOADER_FUNCTION}")"
    echo "snowLoader=${SNOW_LOADER_FUNCTION} state=$(function_state "${SNOW_LOADER_FUNCTION}")"
    echo "weatherSchedule=${WEATHER_SCHEDULE} state=$(rule_state "${WEATHER_SCHEDULE}")"
    echo "roadSchedule=${ROAD_SCHEDULE} state=$(rule_state "${ROAD_SCHEDULE}")"
    echo "snowManifestRule=${SNOW_MANIFEST_RULE} state=$(rule_state "${SNOW_MANIFEST_RULE}")"
    echo "roadFargate cluster=${ROAD_CLUSTER} runningTasks=$(road_running_task_count)"
    ;;
  stop)
    disable_rule "${ROAD_SCHEDULE}"
    disable_rule "${WEATHER_SCHEDULE}"
    disable_rule "${SNOW_MANIFEST_RULE}"
    pause_function "${COLLECTOR_FUNCTION}"
    pause_function "${LOADER_FUNCTION}"
    pause_function "${SNOW_LOADER_FUNCTION}"
    stop_road_tasks
    stop_failed=false
    request_database_stop "${DATABASE_ID}" || stop_failed=true
    request_database_stop "${SNOW_DATABASE_ID}" || stop_failed=true
    if [[ "${stop_failed}" == "true" ]]; then
      exit 1
    fi
    echo "Collection rules are disabled, Lambda execution is paused, and both databases are stopping or stopped."
    ;;
  start)
    request_database_start "${DATABASE_ID}"
    request_database_start "${SNOW_DATABASE_ID}"
    wait_for_database "${DATABASE_ID}"
    wait_for_database "${SNOW_DATABASE_ID}"
    resume_function "${COLLECTOR_FUNCTION}"
    resume_function "${LOADER_FUNCTION}"
    resume_function "${SNOW_LOADER_FUNCTION}"
    enable_rule "${SNOW_MANIFEST_RULE}"
    enable_rule "${WEATHER_SCHEDULE}"
    enable_rule "${ROAD_SCHEDULE}"
    echo "Both databases are available. Lambda execution and collection rules are enabled."
    ;;
  *)
    echo "Unknown action: ${ACTION}" >&2
    exit 2
    ;;
esac
