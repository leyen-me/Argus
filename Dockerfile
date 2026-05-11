# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"

RUN corepack enable

FROM base AS deps
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app

COPY tsconfig.json tsconfig.node.json tsconfig.server.json ./
COPY vite.config.ts drizzle.config.ts components.json ./
COPY src ./src
COPY internal ./internal
COPY pkg ./pkg
COPY drizzle ./drizzle

RUN pnpm build

FROM base AS prod-deps
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --prod --frozen-lockfile
RUN npx playwright install --with-deps chromium

FROM prod-deps AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV HEADLESS_CAPTURE_DISABLE_SANDBOX=true

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/drizzle ./dist-server/drizzle

EXPOSE 8080

USER node

CMD ["node", "dist-server/src/server/index.js"]
