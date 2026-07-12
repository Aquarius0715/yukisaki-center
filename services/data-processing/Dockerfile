FROM python:3.13-slim AS test

WORKDIR /app
ENV PYTHONPATH=/app/src
COPY src ./src
COPY tests ./tests
CMD ["python", "-m", "unittest", "discover", "-v", "-s", "tests"]

FROM python:3.13-slim AS loader

WORKDIR /app
COPY config/requirements-loader.txt ./
RUN pip install --no-cache-dir -r requirements-loader.txt
COPY src ./src
ENV PYTHONPATH=/app/src
ENTRYPOINT ["python", "-m", "data_processing.load_curated"]

FROM public.ecr.aws/lambda/python:3.13 AS runtime

COPY src/ ${LAMBDA_TASK_ROOT}/

CMD ["data_processing.handler.handler"]
