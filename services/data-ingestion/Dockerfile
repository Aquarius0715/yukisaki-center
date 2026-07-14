FROM python:3.13-slim AS test

WORKDIR /app
ENV PYTHONPATH=/app/src
COPY src ./src
COPY tests ./tests
CMD ["python", "-m", "unittest", "discover", "-v", "-s", "tests"]

FROM python:3.13-slim AS road-test

WORKDIR /app
ENV PYTHONPATH=/app/src
COPY src/data_ingestion/road/requirements.txt /tmp/road-requirements.txt
RUN pip install --no-cache-dir -r /tmp/road-requirements.txt
COPY src ./src
COPY tests ./tests
CMD ["python", "-m", "pytest", "-q", "src/data_ingestion/road/tests"]

FROM python:3.13-slim AS road-runtime

WORKDIR /app
ENV PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
COPY src/data_ingestion/road/requirements.txt /tmp/road-requirements.txt
RUN pip install --no-cache-dir -r /tmp/road-requirements.txt
COPY src ./src
CMD ["python", "-m", "data_ingestion.road.src.main"]

FROM public.ecr.aws/lambda/python:3.13 AS runtime

COPY src/ ${LAMBDA_TASK_ROOT}/

CMD ["data_ingestion.weather.handler.handler"]
