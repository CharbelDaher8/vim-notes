# syntax=docker/dockerfile:1

# Two images out of one file: the Node server, and Caddy with the built web
# client baked in. They share the build stage, so the web bundle is compiled
# once and the client Caddy serves is always the one that matches the server.
#
# Build context is the repository root, not this directory:
#   docker compose -f deploy/docker-compose.yml build

# ---- build ------------------------------------------------------------------

FROM node:22-slim AS build

# node-pty compiles native bindings during install. Without a toolchain the
# install fails late and confusingly, so it goes in before anything else.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests before sources: editing a note-store file should not invalidate the
# install layer, which is by far the slowest step here.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @vim-notes/web build

# The server's own build script is enough: packages/server/tsup.config.ts sets
# `noExternal` for @vim-notes/core, without which the bundle would emit
# `import ... from "@vim-notes/core"` and plain node here would be handed a
# TypeScript file and refuse. node-pty stays external, being native.
RUN pnpm --filter @vim-notes/server build

# Production dependency tree, flattened and without the workspace symlinks.
# node-pty is the one that has to survive this: it is native and cannot be
# bundled, so it must be installed rather than compiled into dist/.
#
# `--legacy` is what makes `deploy` work for a workspace that does not set
# inject-workspace-packages. Drop it if that setting is ever turned on.
RUN pnpm --filter @vim-notes/server deploy --prod --legacy /srv/deps

# ---- server -----------------------------------------------------------------

FROM node:22-slim AS server

# git   -- GitVersionControl shells out to it for every commit and sync.
# ripgrep -- what the Search adapter runs.
# neovim  -- not a development convenience. DECISIONS §3: real nvim in a pty is
#            the product, and /term is worthless without it.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ripgrep ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*

# Debian ships an nvim old enough that a modern init.lua will not load, which
# defeats the point of bringing your own config. The official build is pinned to
# a release tag so a rebuild does not silently change the editor underneath you.
ARG NVIM_RELEASE=stable
ARG TARGETARCH
RUN set -eu; \
	case "${TARGETARCH:-amd64}" in \
	amd64) nvim_arch=x86_64 ;; \
	arm64) nvim_arch=arm64 ;; \
	*) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
	esac; \
	curl -fsSL -o /tmp/nvim.tar.gz \
	"https://github.com/neovim/neovim/releases/download/${NVIM_RELEASE}/nvim-linux-${nvim_arch}.tar.gz"; \
	tar -xzf /tmp/nvim.tar.gz -C /opt; \
	mv /opt/nvim-linux-${nvim_arch} /opt/nvim; \
	ln -s /opt/nvim/bin/nvim /usr/local/bin/nvim; \
	rm -f /tmp/nvim.tar.gz; \
	nvim --version | head -1

WORKDIR /srv/server

COPY --from=build /srv/deps/node_modules ./node_modules
COPY --from=build /app/packages/server/dist ./dist

# The container runs as the host user (see docker-compose.yml), so no fixed uid
# is baked in here. Every path nvim writes to therefore has to be a mount or a
# volume the compose file makes writable for that uid.
#
# XDG_CONFIG_HOME is where your init.lua lands: mount a config directory at
# /config/nvim and it is picked up exactly as ~/.config/nvim would be.
ENV XDG_CONFIG_HOME=/config \
	XDG_DATA_HOME=/state/share \
	XDG_STATE_HOME=/state/state \
	XDG_CACHE_HOME=/state/cache \
	NODE_ENV=production

EXPOSE 4321

CMD ["node", "dist/main.js"]

# ---- caddy ------------------------------------------------------------------

FROM caddy:2-alpine AS caddy

# The web client is static once built, so it is baked into the proxy image
# rather than shared through a volume. One less thing to keep in sync, and the
# proxy cannot serve a client the server has never seen.
COPY --from=build /app/packages/web/dist /srv/web
