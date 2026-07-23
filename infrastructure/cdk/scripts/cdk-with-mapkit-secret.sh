#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <synth|diff|deploy> [CDK arguments...]" >&2
  exit 2
fi

CDK_ACTION="$1"
shift

PROFILE="${AWS_PROFILE:-yukisaki-dev}"
REGION="${AWS_REGION:-ap-northeast-1}"
ENVIRONMENT="dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
LOCAL_ENV_FILE="${REPOSITORY_ROOT}/services/web/env.local"
SECRET_NAME=""

arguments=("$@")
index=0
while [[ ${index} -lt ${#arguments[@]} ]]; do
  argument="${arguments[${index}]}"
  case "${argument}" in
    --profile)
      index=$((index + 1))
      PROFILE="${arguments[${index}]}"
      ;;
    --region)
      index=$((index + 1))
      REGION="${arguments[${index}]}"
      ;;
    -c|--context)
      index=$((index + 1))
      context="${arguments[${index}]}"
      if [[ "${context}" == environment=* ]]; then
        ENVIRONMENT="${context#environment=}"
      fi
      ;;
  esac
  index=$((index + 1))
done
SECRET_NAME="yukisaki/${ENVIRONMENT}/web/mapkit-js-token"

read_local_token() {
  local line key value
  [[ -f "${LOCAL_ENV_FILE}" ]] || return 1
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line}" || "${line}" == \#* || "${line}" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "${key}" == "VITE_MAPKIT_TOKEN" ]]; then
      if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
        value="${value:1:${#value}-2}"
      fi
      printf '%s' "${value}"
      return 0
    fi
  done < "${LOCAL_ENV_FILE}"
  return 1
}

read_secret_token() {
  bash "${SCRIPT_DIR}/aws-docker.sh" secretsmanager get-secret-value \
    --secret-id "${SECRET_NAME}" \
    --query SecretString \
    --output text \
    --profile "${PROFILE}" \
    --region "${REGION}" 2>/dev/null
}

TOKEN="${VITE_MAPKIT_TOKEN:-}"
if [[ -z "${TOKEN}" && "${CDK_ACTION}" == "deploy" ]]; then
  TOKEN="$(read_secret_token || true)"
fi
if [[ -z "${TOKEN}" ]]; then
  TOKEN="$(read_local_token || true)"
fi
if [[ -z "${TOKEN}" ]]; then
  TOKEN="$(read_secret_token || true)"
fi
if [[ -z "${TOKEN}" || "${TOKEN}" == "None" ]]; then
  echo "MapKit token not found. Run npm run web:secret:sync -- --profile ${PROFILE} first." >&2
  exit 1
fi

VITE_MAPKIT_TOKEN="${TOKEN}" npx cdk "${CDK_ACTION}" "$@"
