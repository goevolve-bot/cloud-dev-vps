# Build context is the app/ workspace root (see compose.yaml) so pnpm can see
# the workspace manifest and lockfile.
FROM node:22-alpine

WORKDIR /repo
RUN corepack enable

# tsconfig.base.json is extended by every package's tsconfig — without it the
# `tsc -p` steps below cannot resolve their own config.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY core/package.json core/package.json
COPY server/package.json server/package.json
COPY runner/package.json runner/package.json
COPY web/package.json web/package.json

# This image serves the SPA as well as the API, so the install has to cover
# @pm/web's build toolchain (vite, react) and not just @pm/server's runtime.
RUN pnpm install --frozen-lockfile --filter @pm/server... --filter @pm/web...

COPY core ./core
COPY server ./server
COPY web ./web

# "@pm/server..." (with the trailing dots) builds @pm/core first. @pm/server
# imports it as a bare specifier and resolves its types from core/dist, which
# .dockerignore keeps out of the context — so without the topological build the
# server compile fails on TS2307 for every @pm/core import.
RUN pnpm --filter "@pm/server..." run build \
 && pnpm --filter @pm/web run build

# app.ts resolves the SPA relative to its own compiled location
# (server/dist/.. -> /repo/web/dist); PM_WEB_DIR overrides it if that ever
# stops holding.
WORKDIR /repo/server
EXPOSE 3000
CMD ["node", "dist/index.js"]
