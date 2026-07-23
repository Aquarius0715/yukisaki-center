FROM python:3.13-slim AS test
WORKDIR /app
ENV PYTHONPATH=/app/src
COPY src ./src
COPY tests ./tests
CMD ["python", "-m", "unittest", "discover", "-v", "-s", "tests"]

FROM public.ecr.aws/lambda/python:3.13 AS runtime
RUN pip install --no-cache-dir "psycopg[binary]==3.2.9"
COPY src/ ${LAMBDA_TASK_ROOT}/
CMD ["route_planning.handler.handler"]

FROM nginx:1.27-alpine AS viewer
COPY tools/route-viewer/ /usr/share/nginx/html/
COPY tools/route-viewer/nginx.conf /etc/nginx/nginx.conf
