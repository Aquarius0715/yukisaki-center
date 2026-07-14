#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
if [[ -z "${ACTION}" ]]; then
  echo "Usage: $0 <start|stop|status|shell> [--profile PROFILE] [--region REGION] [--stack STACK]" >&2
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
SSM_CLIENT_DIR="${SCRIPT_DIR}/../docker/ssm-client"
SSM_CLIENT_IMAGE="${SSM_CLIENT_IMAGE:-yukisaki-ssm-client:local}"
AWS_CONFIG_DIR="${HOME}/.aws"

aws_cli() {
  bash "${AWS_CLI}" "$@" --profile "${PROFILE}" --region "${REGION}"
}

stack_output() {
  aws_cli cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text
}

DATABASE_ID="$(stack_output DatabaseIdentifier)"
BASTION_INSTANCE_ID="$(stack_output DatabaseBastionInstanceId)"

if [[ "${DATABASE_ID}" == "None" || "${BASTION_INSTANCE_ID}" == "None" ]]; then
  echo "Required CloudFormation outputs are missing. Deploy the latest data pipeline stack first." >&2
  exit 1
fi

database_status() {
  aws_cli rds describe-db-instances \
    --db-instance-identifier "${DATABASE_ID}" \
    --query 'DBInstances[0].DBInstanceStatus' \
    --output text
}

bastion_status() {
  aws_cli ec2 describe-instances \
    --instance-ids "${BASTION_INSTANCE_ID}" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text
}

ssm_status() {
  aws_cli ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=${BASTION_INSTANCE_ID}" \
    --query 'InstanceInformationList[0].PingStatus' \
    --output text
}

print_status() {
  echo "database=${DATABASE_ID} status=$(database_status)"
  echo "bastion=${BASTION_INSTANCE_ID} status=$(bastion_status) ssm=$(ssm_status)"
}

start_database() {
  local status
  status="$(database_status)"
  case "${status}" in
    available)
      ;;
    stopped)
      aws_cli rds start-db-instance --db-instance-identifier "${DATABASE_ID}" >/dev/null
      echo "Waiting for PostgreSQL to become available..."
      aws_cli rds wait db-instance-available --db-instance-identifier "${DATABASE_ID}"
      ;;
    starting)
      echo "Waiting for PostgreSQL to become available..."
      aws_cli rds wait db-instance-available --db-instance-identifier "${DATABASE_ID}"
      ;;
    *)
      echo "Database is ${status}; wait until it becomes available or stopped." >&2
      exit 1
      ;;
  esac
}

start_bastion() {
  local status
  status="$(bastion_status)"
  case "${status}" in
    running)
      ;;
    stopped)
      aws_cli ec2 start-instances --instance-ids "${BASTION_INSTANCE_ID}" >/dev/null
      ;;
    pending)
      ;;
    *)
      echo "Bastion is ${status}; it cannot be started." >&2
      exit 1
      ;;
  esac

  echo "Waiting for the SSM bastion to become ready..."
  aws_cli ec2 wait instance-running --instance-ids "${BASTION_INSTANCE_ID}"
  aws_cli ec2 wait instance-status-ok --instance-ids "${BASTION_INSTANCE_ID}"

  for _ in {1..24}; do
    if [[ "$(ssm_status)" == "Online" ]]; then
      return
    fi
    sleep 5
  done
  echo "Bastion is running, but it did not become online in Systems Manager." >&2
  exit 1
}

stop_bastion() {
  local status
  status="$(bastion_status)"
  case "${status}" in
    running|pending)
      aws_cli ec2 stop-instances --instance-ids "${BASTION_INSTANCE_ID}" >/dev/null
      echo "Stop requested for bastion ${BASTION_INSTANCE_ID}."
      ;;
    stopped|stopping)
      echo "Bastion is already ${status}."
      ;;
    *)
      echo "Bastion is ${status}; it cannot be stopped." >&2
      return 1
      ;;
  esac
}

stop_database() {
  local status
  status="$(database_status)"
  case "${status}" in
    available)
      aws_cli rds stop-db-instance --db-instance-identifier "${DATABASE_ID}" >/dev/null
      echo "Stop requested for database ${DATABASE_ID}."
      ;;
    stopped|stopping)
      echo "Database is already ${status}."
      ;;
    *)
      echo "Database is ${status}; wait until it becomes available or stopped." >&2
      return 1
      ;;
  esac
}

build_ssm_client() {
  docker build --tag "${SSM_CLIENT_IMAGE}" "${SSM_CLIENT_DIR}"
}

docker_tty_args=(--rm -i)
if [[ -t 0 && -t 1 ]]; then
  docker_tty_args+=(-t)
fi

case "${ACTION}" in
  status)
    print_status
    ;;
  start)
    start_database
    start_bastion
    print_status
    echo "Collection schedules were not changed. Run 'npm run db:shell -- --profile ${PROFILE}' to enter the bastion."
    ;;
  stop)
    stop_failed=false
    stop_bastion || stop_failed=true
    stop_database || stop_failed=true
    if [[ "${stop_failed}" == "true" ]]; then
      exit 1
    fi
    echo "Collection schedules and Lambda execution state were not changed."
    ;;
  shell)
    if [[ "$(database_status)" != "available" || "$(bastion_status)" != "running" || "$(ssm_status)" != "Online" ]]; then
      echo "Database and SSM bastion must be ready. Run 'npm run db:start -- --profile ${PROFILE}' first." >&2
      exit 1
    fi
    build_ssm_client
    echo "Opening a Session Manager shell on ${BASTION_INSTANCE_ID}."
    echo "Run 'yukisaki-psql' inside the bastion to connect to PostgreSQL."
    docker run "${docker_tty_args[@]}" \
      --volume "${AWS_CONFIG_DIR}:/root/.aws" \
      "${SSM_CLIENT_IMAGE}" \
      aws ssm start-session \
      --target "${BASTION_INSTANCE_ID}" \
      --profile "${PROFILE}" \
      --region "${REGION}"
    ;;
  *)
    echo "Unknown action: ${ACTION}" >&2
    exit 2
    ;;
esac
