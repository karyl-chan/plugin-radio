ARG NODE_VERSION=22
ARG PNPM_VERSION=10.19.0

# ── build ─────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-trixie-slim AS build
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && \
    pnpm build && \
    pnpm prune --prod

# ── runtime ───────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-trixie-slim AS runtime
# yt-dlp lives in a node-owned dir so the plugin can `yt-dlp -U` itself at
# runtime (see startYtDlpAutoUpdate) — this layer is cached, so the version
# baked here goes stale and YouTube starts 403-ing its stream URLs.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl && \
    mkdir -p /opt/yt-dlp && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /opt/yt-dlp/yt-dlp && \
    chmod a+rx /opt/yt-dlp/yt-dlp && \
    chown -R node:node /opt/yt-dlp && \
    apt-get remove -y curl && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/yt-dlp:${PATH}"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data/music /app/data/covers && chown -R node:node /app/data
VOLUME /app/data/music
VOLUME /app/data/covers
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
