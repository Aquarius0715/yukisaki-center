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
CMD ["python", "-m", "server"]
