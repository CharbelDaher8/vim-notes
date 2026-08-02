# Architecture decisions

Why this is built the way it is. Each entry records what was chosen, what was
rejected, and the reasoning — so that a year from now the tradeoffs are still
legible rather than looking arbitrary.

## 1. Plain markdown files in a git repo are the source of truth

Notes are `.md` files in a directory that is a git repository. Saving
auto-commits. Nothing lives only in a database.

**Why:** version history and offsite backup fall out for free, and the data
outlives the app — if this whole stack disappears, `git clone` still returns
every note. It also means a machine you control can skip the app entirely and
edit notes with real local nvim.

**Rejected:** a database with markdown in a column. Faster to query, but it traps
the data in this application and makes the local-nvim escape hatch impossible.

**Consequence to be honest about:** this app is a *hosted access layer over a git
repo*. Its value is concentrated in machines you cannot or will not clone to —
your phone, a locked-down work PC, a borrowed browser. On your own laptop, local
nvim beats it on every axis.

## 2. Git topology: bare hub, nobody pushes into a live checkout

```
~/notes.git     bare repo — the hub everything pushes to
~/notes/        server working copy, where nvim and the API operate
                fed by a post-receive hook on the hub
your laptop     an ordinary clone of ~/notes.git
```

**Why:** with a laptop clone *and* a server that auto-commits, there are two
independent writers to one history. Git handles the naive version of this badly:
you cannot push to a non-bare repo whose branch is checked out, and
`receive.denyCurrentBranch=updateInstead` only works when the working tree is
perfectly clean — which it will not be two seconds after nvim writes a file.

**Rejected:** treating the server working copy as the remote (fragile, above);
GitHub as the hub (works, adds a third party and round-trip latency, still worth
adding later as a mirror for backup).

## 3. Two clients over one directory

- `/term` — xterm.js over a WebSocket to real nvim in a pty. Your actual
  `init.lua`, your plugins, NERDTree. Serves the work PC.
- `/` — a PWA with CodeMirror 6 and a file tree. Serves the phone.

**Why:** the two use cases have genuinely different input devices, and one UI
cannot serve both well. Fidelity matters where there is a real keyboard;
ergonomics matter where there is not.

**Consequence:** the moment the terminal exists there are two writers to the same
file, which is why §5 and the `FileWatcher` port are not optional.

## 4. Vim keybindings turn off on touch devices

Detected with `matchMedia('(pointer: coarse)')` and `(hover: none)`, never user
agent sniffing. A manual toggle in `localStorage` always overrides the
detection.

**Why:** modal editing assumes Esc and Ctrl exist. On a phone neither does, the
virtual keyboard eats half the viewport, and autocorrect fights the buffer. With
vim off it is a normal, pleasant markdown editor. CodeMirror makes this a
`Compartment.reconfigure()` call, so the cost is about twenty lines.

The override matters more than it looks: a Bluetooth keyboard paired to a phone,
or a touchscreen laptop, both defeat the automatic answer.

## 5. Optimistic concurrency on every write

Reads return a content hash. Writes submit the hash they were based on. A
mismatch is refused, not applied.

**Why:** this is what stops the phone silently destroying what nvim wrote. It is
the only real domain rule in the system, which is why it lives in `core` rather
than in an adapter. See `packages/core/src/domain/conflict.ts`.

## 6. Ports and adapters, with a deliberately thin core

Five ports — `NoteStore`, `VersionControl`, `TerminalHost`, `Search`,
`FileWatcher` — wired by manual constructor injection in a single composition
root.

**Why keep the hexagon:** the same feature code has to run against different
backing implementations that are actually on the roadmap, not hypothetical —
server filesystem now, local files in the Tauri app later; remote pty now,
possibly local later. Ports also make the API layer testable against an
in-memory store with no disk or git involved.

**Why keep the core thin:** count the actual business rules and there are two
(path containment, write conflicts). Everything else is I/O. A rich domain model
here would be scaffolding wrapped around `fs.writeFile`.

**Rejected:** Repository + Unit of Work (no transaction boundary over a
filesystem), CQRS, domain events (nothing would subscribe), and any DI container
— at five ports and one binding set, a container is pure indirection tax.

**Enforced mechanically:** `eslint.config.js` bans Node builtins and
outward-pointing imports inside `packages/core`, so the boundary is a build
failure rather than a code-review convention.

## 7. `NotePath` hand-rolls its path logic

`packages/core/src/domain/note-path.ts` does not use `node:path`.

**Why:** core ships to the browser as well as the server, so a Node builtin would
drag in a polyfill — and this is the one module where a polyfill's edge-case
behaviour is a security bug rather than an inconvenience. `..` is rejected
outright rather than resolved, which removes a whole category of traversal bug,
and `.git` is blocked at any depth because the notes directory *is* a git repo
and a write to `.git/hooks/` would be remote code execution on next save. The
filesystem adapter re-checks containment on the resolved path independently.

## 8. TypeScript end to end

**Why:** a shared `core` package gives compile-time-verified contracts between
server and browser with no codegen step, which on a project this size is worth
more than any other single choice here. `node-pty` is also what VS Code ships, so
the riskiest dependency is well-tested.

**Rejected:** Go on the server. Nicer single-binary deploy, but loses the shared
types, and that trade goes the wrong way here.

## 9. Pinned to TypeScript 6, not 7

**Why:** TS 7 (the native compiler) is `latest`, but `typescript-eslint` still
caps at `<6.1.0`, so type-aware linting breaks on 7. In a codebase that is almost
entirely async pty and WebSocket plumbing, rules like `no-floating-promises`
catch real bugs, and native-compiler speed is irrelevant at this size.

**Revisit when:** `typescript-eslint` ships TS 7 support.

## 10. Tauri over Electron for the desktop app

Thin client to the server. Offline and local sync deliberately deferred.

**Why Tauri:** native OS webview instead of a bundled Chromium — roughly 5 MB
binaries against 150 MB, and far less memory.

**Why a desktop app at all:** mostly keyboard capture. Browsers intercept
`Cmd+W`, `Ctrl+W`, `Cmd+T`, which collide badly with vim and terminal bindings; a
native window gets all of them. Secondarily: no browser chrome, global hotkey,
tray icon.

**Kept cheap by:** a `platform/` port in the web package with `WebPlatform` and
`TauriPlatform` implementations. Feature code never imports a Tauri API directly,
so the desktop target stays a wrapper rather than a second codebase.

**Not signed.** Single-user tool; right-click-open once on macOS and click
through SmartScreen once on Windows beats $200/year in certificates.

## 11. Tailscale for access control

The server binds to the tailnet and is never exposed publicly.

**Why:** the terminal client is effectively a shell on the internet. Not exposing
it at all is a stronger guarantee than any authentication scheme in front of it.

**Risk accepted:** this depends on the work PC being able to join the tailnet.
That was confirmed before committing to it — had it not been, the terminal client
would have lost its entire audience and this would be a phone-first PWA.

**Kept reversible:** authentication is structured so that adding a
password-protected public endpoint behind Caddy is a configuration change rather
than a rewrite.

## Open questions

- **Hosting** is undecided. The stack ships as Docker Compose so the box can be
  chosen later.
- **Offline editing** in the desktop app is deferred. Git does most of the work,
  but sync and conflict UI are real effort and not yet justified.
- **GitHub mirror** of the hub for offsite backup — probably worth it, not done.
