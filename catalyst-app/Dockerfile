# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f catalyst-app/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /build/catalyst-app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY catalyst-app/package.json catalyst-app/package-lock.json ./
RUN npm ci
COPY catalyst-app/tsconfig.json catalyst-app/tsconfig.main.json catalyst-app/vite.config.ts ./
COPY catalyst-app/src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Catalyst Coach" \
      org.opencontainers.image.source="https://github.com/ryank311/lotus-racing"
ENV NODE_ENV=production \
    CATALYST_SERVER_HOST=0.0.0.0 \
    CATALYST_SERVER_PORT=3210 \
    CATALYST_SERVER_DATA_DIR=/data
WORKDIR /opt/catalyst/catalyst-app
COPY --from=build /build/catalyst-app/package.json ./
COPY --from=build /build/catalyst-app/node_modules ./node_modules
COPY --from=build /build/catalyst-app/dist-main ./dist-main
COPY --from=build /build/catalyst-app/dist-renderer ./dist-renderer
COPY tracks/*.yaml /opt/catalyst/tracks/
COPY Lotus/*.md /opt/catalyst/Lotus/
COPY Vette/*.md /opt/catalyst/Vette/
RUN mkdir /data && chown node:node /data
# Validate that production dependencies include the native Linux DuckDB binding.
RUN node -e "require('@duckdb/node-api'); require('./dist-main/main/server.js')"
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3210/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist-main/main/headless.js"]
