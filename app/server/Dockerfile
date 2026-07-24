# Build context is the app/ workspace root (see compose.yaml) so pnpm can see
# the workspace manifest and lockfile.
FROM node:22-alpine

WORKDIR /repo
RUN corepack enable

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY core/package.json core/package.json
COPY server/package.json server/package.json
COPY runner/package.json runner/package.json
COPY web/package.json web/package.json

RUN pnpm install --frozen-lockfile --filter @pm/server...

COPY core ./core
COPY server ./server

RUN pnpm --filter @pm/server run build

WORKDIR /repo/server
EXPOSE 3000
CMD ["node", "dist/index.js"]
