# Lumio: the web app and its server in one image. The server serves the built app and its API (/api) on one port.
# Build-time settings for the app (VITE_*) are passed as build arguments, e.g.
#   docker build --build-arg VITE_JELLYFIN_URL=https://jellyfin.example.org --build-arg VITE_SERVER_LOCKED=true -t lumio .
# and the server's at run time:
#   docker run -p 8097:8097 -e JELLYFIN_URL=https://jellyfin.example.org -v lumio-data:/data lumio

FROM node:24-alpine AS web
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# pnpm applies these to dependencies while installing (patchedDependencies in package.json).
COPY patches ./patches
# The desktop app's Electron is not needed for the web build.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_JELLYFIN_URL
ARG VITE_SERVER_LOCKED
ARG VITE_LASTFM_API_KEY
ARG VITE_TICKETMASTER_API_KEY
ARG VITE_TMDB_API_KEY
ARG VITE_PASSWORD_CHANGE_DISABLED
ARG VITE_ACCOUNT_URL
# Shown in Settings → About (a tag or commit).
ARG LUMIO_BUILD
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
COPY server/package.json ./server/
COPY server/src ./server/src
COPY --from=web /build/dist ./dist
ENV PORT=8097 DATA_DIR=/data WEB_DIR=/app/dist NODE_ENV=production
# Owned by the user the server runs as; a new volume takes this over.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8097
USER node
CMD ["node", "--no-warnings", "server/src/main.ts"]
