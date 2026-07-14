FROM python:3.13-slim AS test

WORKDIR /app
ENV PYTHONPATH=/app/src
COPY src ./src
COPY tests ./tests
CMD ["python", "-m", "unittest", "discover", "-v", "-s", "tests"]

FROM public.ecr.aws/lambda/python:3.13 AS lambda-loader

COPY config/requirements-loader.txt /tmp/requirements-loader.txt
RUN pip install --no-cache-dir -r /tmp/requirements-loader.txt --target ${LAMBDA_TASK_ROOT}
COPY src/ ${LAMBDA_TASK_ROOT}/

CMD ["data_processing.weather.window_loader.handler"]
