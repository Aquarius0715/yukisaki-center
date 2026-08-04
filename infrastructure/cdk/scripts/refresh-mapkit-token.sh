#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-yukisaki-dev}"
REGION="${AWS_REGION:-ap-northeast-1}"
ENVIRONMENT="dev"
DOMAINS=""
LIFETIME_DAYS="180"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

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
    --domains)
      DOMAINS="$2"
      shift 2
      ;;
    --lifetime-days)
      LIFETIME_DAYS="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${DOMAINS}" ]]; then
  DOMAINS="$(node -e '
    const context = require(process.argv[1]).context ?? {};
    const domains = [context.webDomainName, ...(context.webDomainAliases ?? [])].filter(Boolean);
    process.stdout.write(domains.join(","));
  ' "${CDK_DIR}/cdk.json")"
fi
if [[ -z "${DOMAINS}" ]]; then
  echo "No MapKit domains configured. Set webDomainName in cdk.json or pass --domains." >&2
  exit 1
fi

AWS_CLI="${SCRIPT_DIR}/aws-docker.sh"
SERVER_SECRET_NAME="yukisaki/${ENVIRONMENT}/api/apple-maps-server-api"
WEB_SECRET_NAME="yukisaki/${ENVIRONMENT}/web/mapkit-js-token"

aws_cli() {
  bash "${AWS_CLI}" "$@" --profile "${PROFILE}" --region "${REGION}"
}

CREDENTIALS="$(aws_cli secretsmanager get-secret-value \
  --secret-id "${SERVER_SECRET_NAME}" \
  --query SecretString \
  --output text)"
TOKEN="$(printf '%s' "${CREDENTIALS}" | node "${SCRIPT_DIR}/generate-mapkit-token.mjs" "${DOMAINS}" "${LIFETIME_DAYS}")"

if aws_cli secretsmanager describe-secret --secret-id "${WEB_SECRET_NAME}" >/dev/null 2>&1; then
  aws_cli secretsmanager put-secret-value \
    --secret-id "${WEB_SECRET_NAME}" \
    --secret-string "${TOKEN}" >/dev/null
else
  aws_cli secretsmanager create-secret \
    --name "${WEB_SECRET_NAME}" \
    --description "Domain-restricted public MapKit JS token for Yukisaki Web" \
    --secret-string "${TOKEN}" \
    --tags \
      Key=Project,Value=yukisaki-center \
      Key=Environment,Value="${ENVIRONMENT}" \
      Key=Component,Value=web \
      Key=ManagedBy,Value=mapkit-token-refresh-script >/dev/null
fi

EXPIRES_AT="$(node -e 'console.log(new Date(Date.now() + Number(process.argv[1]) * 86400000).toISOString())' "${LIFETIME_DAYS}")"
echo "Updated ${WEB_SECRET_NAME} for ${DOMAINS}; expires before ${EXPIRES_AT}."
