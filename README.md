# vim-notes

Self-hosted notes that are just markdown files in a git repo, reachable from
anywhere. A real shell — and your own nvim — in the browser when you have a
keyboard; a plain markdown editor when you are on a phone.

The repo is the product — this is an access layer over it. Notes stay useful
even if the whole stack goes away: `git clone` and they are all there.

## What it is

| Client      | Where it runs    | What it is                                                                                                                         |
| ----------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/term`     | work PC, desktop | xterm.js over a WebSocket into a real login shell in a pty — run commands, or type `nvim` and get your `init.lua` and your plugins |
| `/`         | phone, anywhere  | PWA with CodeMirror 6, file tree, search. Vim keys on with a keyboard, off on touch                                                |
| desktop app | macOS / Windows  | thin Tauri shell around the same web client, mainly for keyboard capture                                                           |

Both clients read and write the same `~/notes/*.md` directory. Saves
auto-commit and push to a private GitHub repo, so a laptop clone is a first-class way to
work too.

## What it looks like

The same note, in the browser and in real nvim. Both are reading the same file
on disk — edit it in either, or with any other program, and the other notices.

|                                                     |                                                         |
| --------------------------------------------------- | ------------------------------------------------------- |
| ![The editor](docs/screenshots/editor.jpg)          | ![The same note in nvim](docs/screenshots/terminal.jpg) |
| CodeMirror, with wikilinks and backlinks resolved   | `/term` — a shell, with actual nvim a command away      |
| ![Tasks](docs/screenshots/tasks.jpg)                | ![The graph](docs/screenshots/graph.jpg)                |
| `TODO` and `Reminder` lines, grouped by day and due | Notes, days, todos and reminders, and what links them   |

Nothing in those screenshots is stored anywhere but the markdown. The task
list, the due dates, the links and the graph are all parsed back out of the
files every time, which is why a `TODO` typed in nvim shows up in the panel
without nvim knowing this application exists.

## Data blocks

A ` ```chart ` fence is drawn rather than shown. Put the cursor in one and
it is text again — there is no preview pane, so editing a chart is editing the
markdown that makes it.

````markdown
```chart
type: bar
title: Hours on the thing
month, building, reading
May, 34, 12
June, 41, 9
```
````

Options go above the rows, one per line: `type`, `title`, `x`, `y`, `stacked`,
`legend`, `format`, `currency`, `sort`, `height`. Rows are a markdown pipe table
or plain CSV, whichever suits — the first column is the labels, the rest are the
values. Types are `bar`, `line`, `pie` and `table`; `table` is the default and
the only one that never has to be numeric, so changing one word turns a chart
into its own data and back.

The block is **parsed and drawn, never executed** — there is no transpile step
and no `eval` anywhere in it. Notes arrive over git from a remote nothing
protects from a force-push, so a note that draws a chart must not be a note that
runs code. See DECISIONS.md §14.

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

The server also needs `git`, `ripgrep`, `bash` and `nvim` on `PATH`. A missing
`git` is fatal for the same reason; the others only disable search, the terminal
and editing in it, and are reported at startup rather than at the moment you
reach for them. `nvim` is checked even though nothing launches it any more —
`/term` is a shell, so it is a command you type, and a box that forgot to
install it would otherwise look perfectly healthy until you tried to edit.

## Why it is built this way

See [DECISIONS.md](./DECISIONS.md) — including the parts that are deliberately
_not_ built, and the honest limits of the idea.
