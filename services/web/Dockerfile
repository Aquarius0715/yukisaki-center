FROM alpine:3.21 AS test
WORKDIR /app
COPY src ./
COPY tests/test_assets.sh /test_assets.sh
RUN sh /test_assets.sh /app

FROM nginx:1.27-alpine AS runtime
COPY src /usr/share/nginx/html
EXPOSE 80
