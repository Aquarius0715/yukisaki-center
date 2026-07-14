FROM public.ecr.aws/aws-cli/aws-cli:2.35.21

ARG TARGETARCH

USER root

RUN case "${TARGETARCH}" in \
      arm64) plugin_arch="linux_arm64" ;; \
      amd64) plugin_arch="linux_64bit" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && dnf install -y "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/${plugin_arch}/session-manager-plugin.rpm" \
    && dnf clean all

ENTRYPOINT []
CMD ["/bin/bash"]
