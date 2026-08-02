# vim-notes

Self-hosted notes that are just markdown files in a git repo, reachable from
anywhere. Real nvim in the browser when you have a keyboard; a plain markdown
editor when you are on a phone.

The repo is the product — this is an access layer over it. Notes stay useful
even if the whole stack goes away: `git clone` and they are all there.

## What it is

| Client | Where it runs | What it is |
|---|---|---|
| `/term` | work PC, desktop | xterm.js over a WebSocket into real nvim in a pty — your `init.lua`, your plugins, NERDTree |
| `/` | phone, anywhere | PWA with CodeMirror 6, file tree, search. Vim keys on with a keyboard, off on touch |
| desktop app | macOS / Windows | thin Tauri shell around the same web client, mainly for keyboard capture |

Both clients read and write the same `~/notes/*.md` directory. Saves
auto-commit and push to a bare hub, so a laptop clone is a first-class way to
work too.

## Layout

```
packages/
  core/      ports, NotePath, conflict rules, wire schemas — no I/O, no Node builtins
  server/    adapters (fs, git, pty, ripgrep, chokidar), tRPC API, composition root
  web/       React + CodeMirror + xterm, vertical feature slices, platform port
  desktop/   Tauri shell
```

`core` is the interior of the hexagon and imports nothing outward. That is
enforced by lint, not by convention — see `eslint.config.js`.

## Development

Requires Node 22+ and pnpm (via corepack).

```bash
corepack enable pnpm
pnpm install

pnpm dev          # server + web in parallel
pnpm test         # vitest across packages
pnpm typecheck
pnpm lint
```

Point the server at a notes directory with `NOTES_ROOT` (defaults to
`./notes-dev`, which is gitignored).

## Why it is built this way

See [DECISIONS.md](./DECISIONS.md) — including the parts that are deliberately
*not* built, and the honest limits of the idea.
