ARG NUSQLITE3_DIR="/usr/local/lib/nusqlite3"
ARG NUSQLITE3_PATH="${NUSQLITE3_DIR}/libnusqlite3.so"

### STAGE 0: Build client ###
# The Nuxt output is static, so build it on the builder CPU even when the target
# is arm64: it is faster and avoids the npm-in-QEMU segfault (exit 139).
FROM --platform=$BUILDPLATFORM node:24-alpine AS build-client

WORKDIR /client
COPY /client /client
RUN npm ci && npm cache clean --force
RUN npm run generate

### STAGE 1: Compile server on the builder CPU (avoid QEMU SIGILL from tsc on arm64) ###
FROM --platform=$BUILDPLATFORM node:24-alpine AS compile-server

WORKDIR /server
COPY index.js package* tsconfig.server.json /server
COPY /server /server/server
RUN npm ci --include=dev --ignore-scripts && npm run build:server

### STAGE 2: Install native server deps for the target arch ###
FROM node:24-alpine AS build-server

ARG NUSQLITE3_DIR
ARG TARGETPLATFORM

ENV NODE_ENV=production

RUN apk add --no-cache --update \
  curl \
  make \
  python3 \
  g++ \
  unzip

WORKDIR /server
COPY index.js package* /server
COPY /server /server/server
COPY --from=compile-server /server/dist-server /server/dist-server

# sqlite3 has no prebuilt binary for linux/arm64-musl, so npm builds it from
# source here; that is why make/python3/g++ are installed above.
RUN case "$TARGETPLATFORM" in \
  "linux/amd64") \
  curl -L -o /tmp/library.zip "https://github.com/mikiher/nunicode-sqlite/releases/download/v1.2/libnusqlite3-linux-musl-x64.zip" ;; \
  "linux/arm64") \
  curl -L -o /tmp/library.zip "https://github.com/mikiher/nunicode-sqlite/releases/download/v1.2/libnusqlite3-linux-musl-arm64.zip" ;; \
  *) echo "Unsupported platform: $TARGETPLATFORM" && exit 1 ;; \
  esac && \
  unzip /tmp/library.zip -d $NUSQLITE3_DIR && \
  rm /tmp/library.zip

RUN npm ci --omit=dev && npm cache clean --force && rm -rf /root/.npm

### STAGE 3: Create minimal runtime image ###
FROM node:24-alpine

ARG NUSQLITE3_DIR
ARG NUSQLITE3_PATH
# Build metadata, injected by build-strm-image.yml so /api/status and the
# startup log can report exactly which upstream release + commit this is.
ARG GIT_SHA=""
ARG UPSTREAM_TAG=""
ARG BUILD_TIME=""

LABEL org.opencontainers.image.title="audiobookshelf-strm" \
      org.opencontainers.image.source="https://github.com/zxyxyxx/audiobookshelf-strm" \
      org.opencontainers.image.version="${UPSTREAM_TAG}" \
      org.opencontainers.image.revision="${GIT_SHA}"

# tini = PID 1 reaper, tzdata = correct TZ, ffmpeg = only for the rare transcode.
# The runtime only executes `node dist-server/index.js`, so npm/yarn/corepack are
# dead weight (~15 MB) and are dropped, together with man pages and doc files.
RUN apk add --no-cache --update \
  tzdata \
  ffmpeg \
  tini \
  && rm -rf /usr/share/man /usr/share/doc /var/cache/apk/* \
  && rm -rf /usr/local/lib/node_modules/npm \
            /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm /usr/local/bin/npx \
            /usr/local/bin/corepack /usr/local/bin/yarn \
            /usr/local/bin/yarnpkg /usr/local/bin/pnpx

WORKDIR /app

# Copy only what the server loads at runtime: compiled output, prod deps, manifest.
# (The original server/ sources are already compiled into dist-server.)
COPY --from=build-client /client/dist /app/client/dist
COPY --from=build-server /server/dist-server /app/dist-server
COPY --from=build-server /server/node_modules /app/node_modules
COPY --from=build-server /server/package.json /app/package.json
COPY --from=build-server ${NUSQLITE3_PATH} ${NUSQLITE3_PATH}

# mocha suites and the tsc incremental cache are build artefacts, not runtime files.
RUN rm -rf /app/dist-server/test /app/dist-server/.tsbuildinfo

EXPOSE 80

ENV PORT=80
ENV NODE_ENV=production
ENV CONFIG_PATH="/config"
ENV METADATA_PATH="/metadata"
ENV SOURCE="docker"
ENV NUSQLITE3_DIR=${NUSQLITE3_DIR}
ENV NUSQLITE3_PATH=${NUSQLITE3_PATH}
ENV STRM_GIT_SHA=${GIT_SHA}
ENV STRM_UPSTREAM_TAG=${UPSTREAM_TAG}
ENV STRM_BUILD_TIME=${BUILD_TIME}

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist-server/index.js"]

# Liveness probe against the endpoint the server already exposes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 80) + '/healthcheck').then(function (r) { process.exit(r.ok ? 0 : 1) }).catch(function () { process.exit(1) })"
