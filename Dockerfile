FROM node:22-bookworm-slim AS build
ARG GLINT_WEB_BASE_PATH=/
WORKDIR /app
RUN npm install -g pnpm@11.18.0 --ignore-scripts
COPY . .
RUN pnpm install --frozen-lockfile && GLINT_WEB_BASE_PATH=$GLINT_WEB_BASE_PATH pnpm --filter glint-web build

FROM node:22-bookworm-slim AS production-deps
WORKDIR /app
ENV CI=1
RUN npm install -g pnpm@11.18.0 --ignore-scripts
COPY . .
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22-bookworm-slim
ARG DEBIAN_MIRROR=http://deb.debian.org
ARG GLINT_WEB_BASE_PATH=/
ENV NODE_ENV=production CI=1 GLINT_HOST=0.0.0.0 PORT=4175 GLINT_CHROME_PATH=/usr/bin/chromium GLINT_WEB_BASE_PATH=$GLINT_WEB_BASE_PATH
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 install -y --no-install-recommends chromium ffmpeg git fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11.18.0 --ignore-scripts
WORKDIR /app
COPY --from=production-deps --chown=node:node /app /app
COPY --from=build --chown=node:node /app/apps/web/dist /app/apps/web/dist
RUN mkdir -p skills apps/studio/out apps/studio/.cache \
    && if [ -d .agents/skills ]; then for d in .agents/skills/*; do [ -d "$d" ] || continue; name=${d##*/}; if [ -L "skills/$name" ]; then rm "skills/$name"; fi; cp -a "$d" skills/; done; fi \
    && chown -R node:node skills apps/studio/out apps/studio/.cache
USER node
EXPOSE 4175
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4175/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "glint-web", "serve"]
