# nvim config for the container

Whatever is in this directory is mounted read-only at `~/.config/nvim` inside
the server container, so `init.lua` here is loaded by the nvim that `/term`
attaches to.

This directory exists mainly so the default bind mount in `docker-compose.yml`
has something to point at. If you already keep your nvim config in a dotfiles
repository, point `NVIM_CONFIG_DIR` in `deploy/.env` at that checkout instead
and ignore this one.

Two things to know before moving your real config in:

- **The mount is read-only.** A plugin manager that wants to write into
  `~/.config/nvim` will fail rather than half-succeed. Plugins that install into
  `~/.local/share/nvim` (lazy.nvim, packer, mason) are fine — that path is the
  `nvim-state` volume and is writable.
- **Anything your config shells out to has to exist in the image.** `/term` is
  a shell now (DECISIONS §3), so you can check by typing the command — if it is
  not there, add it to the server stage of `deploy/Dockerfile`.
