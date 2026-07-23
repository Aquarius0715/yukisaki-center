#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
if [[ "${ACTION}" != "sync" ]]; then
  echo "Usage: $0 sync [--profile PROFILE] [--region REGION] [--environment ENV] [--env-file FILE]" >&2
  exit 2
fi
shift

PROFILE="${AWS_PROFILE:-yukisaki-dev}"
REGION="${AWS_REGION:-ap-northeast-1}"
ENVIRONMENT="dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
ENV_FILE="${REPOSITORY_ROOT}/services/web/env.local"

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
    --environment)
      ENVIRONMENT="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "MapKit environment file not found: ${ENV_FILE}" >&2
  exit 1
fi

read_env_value() {
  local target_key="$1"
  local line key value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line}" || "${line}" == \#* || "${line}" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "${key}" == "${target_key}" ]]; then
      if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
        value="${value:1:${#value}-2}"
      fi
      printf '%s' "${value}"
      return 0
    fi
  done < "${ENV_FILE}"
  return 1
}

TOKEN="$(read_env_value VITE_MAPKIT_TOKEN || true)"
if [[ -z "${TOKEN}" || "${TOKEN}" == "replace-with-domain-restricted-mapkit-js-token" ]]; then
  echo "VITE_MAPKIT_TOKEN is missing from ${ENV_FILE}." >&2
  exit 1
fi

AWS_CLI="${SCRIPT_DIR}/aws-docker.sh"
SECRET_NAME="yukisaki/${ENVIRONMENT}/web/mapkit-js-token"

aws_cli() {
  bash "${AWS_CLI}" "$@" --profile "${PROFILE}" --region "${REGION}"
}

if aws_cli secretsmanager describe-secret --secret-id "${SECRET_NAME}" >/dev/null 2>&1; then
  aws_cli secretsmanager put-secret-value \
    --secret-id "${SECRET_NAME}" \
    --secret-string "${TOKEN}" >/dev/null
  echo "Updated Secrets Manager secret ${SECRET_NAME}."
else
  aws_cli secretsmanager create-secret \
    --name "${SECRET_NAME}" \
    --description "Domain-restricted public MapKit JS token for Yukisaki Web" \
    --secret-string "${TOKEN}" \
    --tags \
      Key=Project,Value=yukisaki-center \
      Key=Environment,Value="${ENVIRONMENT}" \
      Key=Component,Value=web \
      Key=ManagedBy,Value=mapkit-secret-script >/dev/null
  echo "Created Secrets Manager secret ${SECRET_NAME}."
fi
