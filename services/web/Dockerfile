FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html tsconfig.json vite.config.ts ./
COPY .figma ./.figma
COPY public ./public
COPY src ./src

ARG VITE_DATA_MODE=api
ARG VITE_YUKISAKI_API_URL
ARG VITE_PUBLIC_BASE_PATH=/
ARG VITE_ENABLE_MOCK_FALLBACK=true
ENV VITE_DATA_MODE=$VITE_DATA_MODE
ENV VITE_YUKISAKI_API_URL=$VITE_YUKISAKI_API_URL
ENV VITE_PUBLIC_BASE_PATH=$VITE_PUBLIC_BASE_PATH
ENV VITE_ENABLE_MOCK_FALLBACK=$VITE_ENABLE_MOCK_FALLBACK

RUN --mount=type=secret,id=mapkit_token,env=VITE_MAPKIT_TOKEN \
    pnpm typecheck && pnpm build

FROM build AS test

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
