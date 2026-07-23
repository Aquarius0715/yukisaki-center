FROM python:3.13-slim AS test
WORKDIR /app
ENV PYTHONPATH=/app/src
COPY src ./src
COPY tests ./tests
CMD ["python", "-m", "unittest", "discover", "-v", "-s", "tests"]

FROM public.ecr.aws/lambda/python:3.13-arm64 AS runtime
COPY config/requirements-runtime.txt /tmp/requirements-runtime.txt
RUN pip install --no-cache-dir -r /tmp/requirements-runtime.txt --target ${LAMBDA_TASK_ROOT}
COPY src/ ${LAMBDA_TASK_ROOT}/
CMD ["drivability_scoring.handler.handler"]
