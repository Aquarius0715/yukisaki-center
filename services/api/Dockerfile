FROM python:3.13-slim AS test
WORKDIR /app
ENV PYTHONPATH=/app/src
COPY src ./src
COPY tests ./tests
CMD ["python", "-m", "unittest", "discover", "-v", "-s", "tests"]

FROM python:3.13-slim AS runtime
WORKDIR /app
COPY src ./src
ENV PYTHONPATH=/app/src
EXPOSE 8080
CMD ["python", "-c", "from yukisaki_api.handler import handler; print('Use the AWS Lambda image target for deployment')"]

FROM public.ecr.aws/lambda/python:3.13-arm64 AS lambda
RUN pip install --no-cache-dir "psycopg[binary]==3.2.9"
COPY src/yukisaki_api ${LAMBDA_TASK_ROOT}/yukisaki_api
CMD ["yukisaki_api.handler.handler"]
