# vim-notes

Self-hosted notes that are just markdown files in a git repo, reachable from
anywhere. Real nvim in the browser when you have a keyboard; a plain markdown
editor when you are on a phone.

The repo is the product — this is an access layer over it. Notes stay useful
even if the whole stack goes away: `git clone` and they are all there.

## What it is

| Client      | Where it runs    | What it is                                                                                  |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------- |
| `/term`     | work PC, desktop | xterm.js over a WebSocket into real nvim in a pty — your `init.lua`, your plugins, NERDTree |
| `/`         | phone, anywhere  | PWA with CodeMirror 6, file tree, search. Vim keys on with a keyboard, off on touch         |
| desktop app | macOS / Windows  | thin Tauri shell around the same web client, mainly for keyboard capture                    |

Both clients read and write the same `~/notes/*.md` directory. Saves
auto-commit and push to a private GitHub repo, so a laptop clone is a first-class way to
work too.

## What it looks like

The same note, in the browser and in real nvim. Both are reading the same file
on disk — edit it in either, or with any other program, and the other notices.

|                                                     |                                                         |
| --------------------------------------------------- | ------------------------------------------------------- |
| ![The editor](docs/screenshots/editor.jpg)          | ![The same note in nvim](docs/screenshots/terminal.jpg) |
| CodeMirror, with wikilinks and backlinks resolved   | `/term` — actual nvim, your config, your plugins        |
| ![Tasks](docs/screenshots/tasks.jpg)                | ![The graph](docs/screenshots/graph.jpg)                |
| `TODO` and `Reminder` lines, grouped by day and due | Notes, days, todos and reminders, and what links them   |

Nothing in those screenshots is stored anywhere but the markdown. The task
list, the due dates, the links and the graph are all parsed back out of the
files every time, which is why a `TODO` typed in nvim shows up in the panel
without nvim knowing this application exists.

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

git init notes-dev   # see below — required, once

pnpm dev          # server + web in parallel
pnpm test         # vitest across packages
pnpm typecheck
pnpm lint
pnpm verify       # typecheck + lint + format + test, same as CI
```

Point the server at a notes directory with `NOTES_ROOT` (defaults to
`./notes-dev`, which is gitignored).

`pnpm dev` runs the web client against the real server: Vite proxies `/trpc` to
it, including the WebSocket the file watcher streams over. To work on the UI
with no server, no notes directory and no git, run the client against its
built-in fake instead:

```bash
VITE_PLATFORM=memory pnpm --filter @vim-notes/web dev
```

That serves seeded notes from `InMemoryPlatform` and turns on the `demo` menu in
the header, which fakes nvim and git writing to the directory so the conflict
and reconcile paths can be reached without a terminal. It is gated on Vite's
`DEV` flag, so a production build compiles the option away entirely rather than
leaving a switch a deployed client could be talked into.

**The notes directory has to be its own git repository**, and the server refuses
to start otherwise. That is not pedantry. `./notes-dev` sits inside this
repository, so without its own `.git` it inherits this one — and then
auto-commit either records nothing at all (because the path is ignored) or
starts committing this repository's source tree into its own history. Both fail
silently: saves work, commits report "nothing to commit", and history quietly
stops. Preflight checks it at boot and prints the exact command to fix it.

The server also needs `git`, `ripgrep` and `nvim` on `PATH`. A missing `git` is
fatal for the same reason; the other two only disable search and the terminal,
and are reported at startup rather than at the moment you reach for them.

## Why it is built this way

See [DECISIONS.md](./DECISIONS.md) — including the parts that are deliberately
_not_ built, and the honest limits of the idea.
