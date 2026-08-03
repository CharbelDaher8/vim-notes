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

# What the server shells out to, and what a shell in /term is worth having.
# This list has to agree with `requiredBinaries` in
# packages/server/src/preflight.ts and with the install step in
# .github/workflows/ci.yml -- nothing enforces that, so the server checks at
# boot and says which one is missing.
#
# git     -- GitVersionControl shells out to it for every commit and sync.
# openssh -- git needs it to reach GitHub over ssh (DECISIONS §2). Installing
#            git alone gets you a push that fails with "unable to find ssh".
# ripgrep -- what the Search adapter runs (the binary is `rg`), and what
#            telescope's live grep runs too.
# neovim  -- not a development convenience. DECISIONS §3: /term is a shell, and
#            a shell on a notes server with no editor is a poor joke.
#
# The compiler is here for the config, not for the server. A modern nvim setup
# compiles things on first launch and keeps doing it as you open new filetypes:
# telescope-fzf-native has `build = "make"`, and nvim-treesitter with
# `auto_install` builds a parser the first time it meets a language. Both happen
# at *runtime*, inside this image, so a build-stage toolchain would not help.
#
# It costs about 250MB, which is the honest price of "my config, working". If
# that ever matters more than it does, the lever is `auto_install = false` plus
# a pre-built parser set, not dropping the compiler and finding out one filetype
# at a time.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
	git openssh-client ripgrep ca-certificates curl \
	build-essential fd-find \
	&& rm -rf /var/lib/apt/lists/*

# Debian ships it as `fdfind` -- the name `fd` was taken by another package --
# and every config in the world calls it `fd`.
RUN ln -s "$(command -v fdfind)" /usr/local/bin/fd

# lazygit, because `<leader>gg` in the mounted config opens it and a keybinding
# that errors is worse than one that is absent. Not in Debian, so it comes from
# the release tarball and is pinned for the same reason nvim is: a rebuild
# should not change the tools underneath you.
#
# It earns its place here beyond the config: this box auto-commits every save,
# and lazygit is the fastest way to see what that has been doing.
ARG LAZYGIT_VERSION=0.63.1
# Declared here as well as before the nvim block below. A build ARG is scoped
# from its declaration onward, so without this `${TARGETARCH:-amd64}` silently
# reads empty and falls back to amd64 -- which is right on the box this deploys
# to today and wrong the first time anyone builds on ARM, with the failure
# arriving as an exec-format error inside lazygit rather than here.
ARG TARGETARCH
RUN set -eu; \
	case "${TARGETARCH:-amd64}" in \
	amd64) lazygit_arch=x86_64 ;; \
	arm64) lazygit_arch=arm64 ;; \
	*) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
	esac; \
	curl -fsSL -o /tmp/lazygit.tar.gz \
	"https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_linux_${lazygit_arch}.tar.gz"; \
	tar -xzf /tmp/lazygit.tar.gz -C /usr/local/bin lazygit; \
	rm -f /tmp/lazygit.tar.gz; \
	lazygit --version

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
