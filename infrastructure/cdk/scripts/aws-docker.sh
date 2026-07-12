#!/usr/bin/env bash
set -euo pipefail

AWS_CLI_IMAGE="${AWS_CLI_IMAGE:-public.ecr.aws/aws-cli/aws-cli:2.35.21}"
AWS_CONFIG_DIR="${HOME}/.aws"

mkdir -p "${AWS_CONFIG_DIR}"

docker_args=(--rm -i)
if [[ -t 0 && -t 1 ]]; then
  docker_args+=(-t)
fi

docker run "${docker_args[@]}" \
  -v "${AWS_CONFIG_DIR}:/root/.aws" \
  "${AWS_CLI_IMAGE}" \
  "$@"
