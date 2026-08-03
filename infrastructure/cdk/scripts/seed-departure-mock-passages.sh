#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-yukisaki-dev}"
REGION="${AWS_REGION:-ap-northeast-1}"
DATA_STACK_NAME="${DATA_STACK_NAME:-YukisakiDataPipeline-dev}"
MODE="seed"

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
    --teardown)
      MODE="teardown"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_CLI="${SCRIPT_DIR}/aws-docker.sh"
if [[ "${MODE}" == "teardown" ]]; then
  SQL_FILE="${SCRIPT_DIR}/mock-data/departure-training-seed-teardown.sql"
else
  SQL_FILE="${SCRIPT_DIR}/mock-data/departure-training-seed.sql"
fi

aws_cli() {
  bash "${AWS_CLI}" "$@" --profile "${PROFILE}" --region "${REGION}"
}

stack_output() {
  aws_cli cloudformation describe-stacks \
    --stack-name "${DATA_STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text
}

DATABASE_ID="$(stack_output DatabaseIdentifier)"
BASTION_INSTANCE_ID="$(stack_output DatabaseBastionInstanceId)"

DATABASE_STATUS="$(aws_cli rds describe-db-instances \
  --db-instance-identifier "${DATABASE_ID}" \
  --query 'DBInstances[0].DBInstanceStatus' \
  --output text)"
if [[ "${DATABASE_STATUS}" != "available" ]]; then
  echo "Database ${DATABASE_ID} is ${DATABASE_STATUS}. Run 'npm run db:start -- --profile ${PROFILE}' first." >&2
  exit 1
fi

BASTION_STATUS="$(aws_cli ec2 describe-instances \
  --instance-ids "${BASTION_INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text)"
SSM_STATUS="$(aws_cli ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=${BASTION_INSTANCE_ID}" \
  --query 'InstanceInformationList[0].PingStatus' \
  --output text)"
if [[ "${BASTION_STATUS}" != "running" || "${SSM_STATUS}" != "Online" ]]; then
  echo "Bastion ${BASTION_INSTANCE_ID} is not ready (state=${BASTION_STATUS}, ssm=${SSM_STATUS})." >&2
  echo "Run 'npm run db:start -- --profile ${PROFILE}' first." >&2
  exit 1
fi

echo "Running ${SQL_FILE} against ${DATABASE_ID} via bastion ${BASTION_INSTANCE_ID}..."

# aws-docker.sh runs the CLI inside a container that only mounts
# ${HOME}/.aws, so a file:// path on the host filesystem (e.g. from
# mktemp) does not resolve inside it. Piping through file:///dev/stdin
# works because `docker run -i` connects the container's stdin to ours.
SQL_BODY="$(cat "${SQL_FILE}")"
PARAMS_JSON="$(python3 - "${SQL_BODY}" <<'PYEOF'
import json
import sys

sql = sys.argv[1]
commands = [
    "set -e",
    "export AWS_PAGER=''",
    "cat <<'DEPARTURE_SEED_SQL' | yukisaki-psql -v ON_ERROR_STOP=1\n" + sql + "\nDEPARTURE_SEED_SQL",
]
json.dump({"commands": commands}, sys.stdout)
PYEOF
)"

COMMAND_ID="$(aws_cli ssm send-command \
  --instance-ids "${BASTION_INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --parameters file:///dev/stdin \
  --query "Command.CommandId" --output text <<< "${PARAMS_JSON}")"

echo "Command ${COMMAND_ID} submitted, waiting for it to finish..."
STATUS="Pending"
until [[ "${STATUS}" == "Success" || "${STATUS}" == "Failed" || "${STATUS}" == "Cancelled" || "${STATUS}" == "TimedOut" ]]; do
  sleep 3
  STATUS="$(aws_cli ssm get-command-invocation \
    --command-id "${COMMAND_ID}" \
    --instance-id "${BASTION_INSTANCE_ID}" \
    --query "Status" --output text 2>/dev/null || echo "Pending")"
done

aws_cli ssm get-command-invocation \
  --command-id "${COMMAND_ID}" \
  --instance-id "${BASTION_INSTANCE_ID}" \
  --output json

if [[ "${STATUS}" != "Success" ]]; then
  echo "Command finished with status ${STATUS}." >&2
  exit 1
fi
