FROM node:22-alpine AS deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY tsconfig.json vitest.config.mjs wrangler.toml ./
COPY scripts ./scripts
COPY src ./src
RUN pnpm build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=52389 \
    UPSTREAM_SOCKET=false

COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/docker-server.mjs ./scripts/docker-server.mjs

EXPOSE 52389
CMD ["node", "scripts/docker-server.mjs"]
