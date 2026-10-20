FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.18.0 --ignore-scripts
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter glint-web build

FROM node:22-bookworm-slim AS production-deps
WORKDIR /app
ENV CI=1
RUN npm install -g pnpm@11.18.0 --ignore-scripts
COPY . .
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22-bookworm-slim
ENV NODE_ENV=production CI=1 GLINT_HOST=0.0.0.0 PORT=4175 GLINT_CHROME_EXECUTABLE=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends chromium ffmpeg fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11.18.0 --ignore-scripts
WORKDIR /app
COPY --from=production-deps --chown=node:node /app /app
COPY --from=build --chown=node:node /app/apps/web/dist /app/apps/web/dist
RUN mkdir -p apps/studio/out apps/studio/.cache && chown node:node apps/studio/out apps/studio/.cache
USER node
EXPOSE 4175
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4175/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "glint-web", "serve"]
