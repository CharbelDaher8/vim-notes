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

**Consequence to be honest about:** this app is a _hosted access layer over a git
repo_. Its value is concentrated in machines you cannot or will not clone to —
your phone, a locked-down work PC, a borrowed browser. On your own laptop, local
nvim beats it on every axis.

## 2. Git topology: a private GitHub repo is the remote

```
github.com/you/notes   private repo — the remote everything pushes to
~/notes/               server working copy, an ordinary clone
                       polls every 60s to pull and push
your laptop            an ordinary clone, from anywhere
```

**Changed.** This originally specified a bare hub at `~/notes.git` on the server,
with the working copy fed by a `post-receive` hook. That is written down rather
than quietly edited away, because the reasoning that produced it was sound and
the thing that changed was a premise, not a mistake in the logic.

The hub existed to solve exactly one problem: you cannot push into a repository
whose branch is checked out, and `receive.denyCurrentBranch=updateInstead` needs
a perfectly clean working tree, which this one will not have two seconds after
nvim writes a file. A bare repo sidesteps that.

But that problem only exists if the server is the thing being pushed to. Point
both clones at GitHub instead and it never arises — so the fix **removes** a
component rather than adding one. No `~/notes.git`, no hook, no bootstrap step
for either.

**Why:** offsite backup, which the hub never provided. Under the old topology
the only copies were the VPS and whatever the laptop had last pulled, so losing
the box lost everything not on the laptop — for a design whose whole pitch is
that the data outlives the app (§1), that was the weakest part of it. Secondly,
the laptop can now push from anywhere rather than only from the tailnet.

**What it costs, honestly:**

- **The server cannot be told about a push.** It is tailnet-only (§11), so no
  webhook can reach it. Instant propagation via `post-receive` becomes polling,
  and a note written on the laptop takes up to `SYNC_INTERVAL_MS` to appear.
  That is a real regression and it is the price of the trade.
- **A third party is now in the loop.** GitHub being down means no sync — though
  local editing, history and search are all unaffected, because every clone is a
  full repository.
- **A third party now stores the plaintext of every note.** The repository is
  private, but this is a different kind of change from the availability one
  above and worth stating rather than leaving to be inferred: §1's pitch is that
  the data outlives the app, and it now also lives somewhere its owner does not
  control. Under the old topology every copy was on hardware the user owned.
- **A credential now exists.** An SSH deploy key, scoped to that one repository,
  mounted into the container and never baked into the image.

**Rejected:** treating the server working copy as the remote (fragile, above);
keeping the hub _and_ adding GitHub as a mirror — two remotes to keep in sync
and two ways for it to go wrong, to avoid a polling delay measured in seconds.

**Consequence:** conflicts do not go away, they move. Two writers to one history
is still the shape of the system, and `sync()` still returns them as typed
outcomes rather than throwing. The care that used to live in the hook — never
stash, never `reset --hard`, never leave a rebase half-done under a live editor
— now lives in the pull path, which is where it belonged anyway.

## 3. Two clients over one directory

- `/term` — xterm.js over a WebSocket to a real login shell in a pty. Run
  commands, check `git log`, and type `nvim` when you want the editor, with your
  actual `init.lua` and your plugins. Serves the work PC.
- `/` — a PWA with CodeMirror 6 and a file tree. Serves the phone.

**Why:** the two use cases have genuinely different input devices, and one UI
cannot serve both well. Fidelity matters where there is a real keyboard;
ergonomics matter where there is not.

**Why a shell and not nvim directly.** It launched nvim as PID 1 of the pty
until 2026-08-03, which made the one thing a terminal is for — running a command
— reachable only through `:!`, and left no way to do anything between quitting
the editor and reloading the page. An editor is a program you run in a terminal,
not a thing a terminal is.

This gave up nothing in security, which is the objection to expect. nvim in a
pty runs `:!sh` for the asking, so `/term` was always a shell — the change makes
it honest rather than more dangerous. What is worth stating plainly, and is
unchanged either way: in the deployed container that shell can read the notes
deploy key at `/run/secrets/notes-deploy-key`, so anything that can open this
socket can push to the notes repo. §11 is the boundary that has to hold.

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

**The cost, which is structural rather than incidental:** the composition root
is the highest-risk file here and the one the test suite cannot reach. That
follows directly from the property that makes the rest of it testable — feature
code is built not to know what it is wired to, so every test runs against a
fake, and the line that chooses the real implementation is by definition the
line no test observes. The components on either side of a bad wire are both
correct, both covered, and connected to nothing.

This build produced five of them. Two are worth naming because they were
invisible in exactly this way: `main.tsx` constructed `InMemoryPlatform`, so the
whole web client ran against a fake with a fully tested `WebPlatform` sitting
unused beside it; and `withGlobalTauri` was left unset, so the desktop build
reported itself as a browser, fell back to the browser host, and never rendered
the only screen that could tell it where its server was. Every one was one line.

**Mitigation, such as it is:** start the thing and look at it. There is no
cleverer answer — an integration test broad enough to catch this is a second
composition root with its own wiring to get wrong. What does help is making the
wiring say what it assumes: preflight logs the resolved path of every binary and
the actual remote URL at boot, and the client reports which origin it resolved
and where from. Every one of the five was found by running it and reading the
first ten lines of output.

## 7. `NotePath` hand-rolls its path logic

`packages/core/src/domain/note-path.ts` does not use `node:path`.

**Why:** core ships to the browser as well as the server, so a Node builtin would
drag in a polyfill — and this is the one module where a polyfill's edge-case
behaviour is a security bug rather than an inconvenience. `..` is rejected
outright rather than resolved, which removes a whole category of traversal bug,
and `.git` is blocked at any depth because the notes directory _is_ a git repo
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

## 12. Todos, reminders and links are parsed, never stored

A line beginning `TODO` or `Reminder` becomes a task; `[[wikilinks]]` connect
notes; a note whose filename looks like a date is a day. All of it is recomputed
from the markdown, and the index owns nothing.

**Why:** it is the only design where a TODO typed in nvim in the pty appears in
the panel without nvim knowing this application exists. It also cannot drift out
of sync with the file, and deleting the index is a no-op rather than data loss —
the same property §1 buys for the notes themselves.

**Rejected:** a tasks table alongside the notes. Faster to query and sortable by
anything, but it makes the file and the database two sources of truth that
disagree the moment anything writes outside the app — which is precisely the
thing this app is built around.

**Consequences accepted:**

- Keywords are anchored to the start of a line. An unanchored match would claim
  every sentence that mentions the word.
- Fenced code blocks are skipped: a shell snippet containing `# TODO` is a
  quotation, and hoovering it into a task list would make the feature
  untrustworthy the first time it happened.
- Checkbox state is three-valued. `- [ ] TODO x` is open, `- [x] TODO x` is
  done, and a bare `TODO x` was never asked — which decides whether ticking it
  rewrites a checkbox or inserts one.
- Ticking a box in the panel **edits the markdown**, through the same
  conflict-checked write path as everything else. There is nowhere else to put
  the fact.
- A note is a "day" by filename, not by living under `journal/`, so dailies join
  up however they are filed.

## 13. The graph lays itself out; no layout library

Force simulation written by hand, rendered as SVG.

**Why:** the layout maths is pure and therefore testable, which is the culture
here, and a graph library would hand back most of the 84 kB that code-splitting
xterm off the mobile bundle just saved. The phone is a first-class client
(§3–§4) and it is the one that pays for every dependency.

**Node ids are content-derived and carry no line number.** That is what stops
the layout jumping when a line is inserted above a TODO. The line travels as its
own field on the node instead — see `GraphNode.line`, and the comment there for
why reconstructing it by matching label text is a trap.

## 14. Data blocks are parsed and drawn, never executed

A ` ```chart ` fence holds `key: value` options above rows written as a
markdown pipe table or plain CSV. It is parsed to a plain data structure, turned
into coordinates, and drawn as SVG. Four types: `bar`, `line`, `pie`, `table`.

**Why not a language that compiles to TSX or Python,** which is the obvious
design and was the original request:

- Generated code has to be **executed**. In the browser that means `eval` over
  text that arrived from a git remote which nothing protects from a force-push
  (§2, and the same open question below). Today the worst a hostile note can do
  is look strange. With a transpiler, opening a note runs code in the session.
  §7 hand-rolls `NotePath` specifically so a note cannot reach `.git/hooks`;
  this would reopen that door from the other side.
- Python means a server round trip per render — so charts stop working in the
  desktop app and while offline, and every keystroke inside a block hits the
  network — or Pyodide, roughly 10 MB of wasm on a bundle that code-splits xterm
  to save 84 kB (§13).
- It is three layers where one works. `text → data → SVG`. The code-generation
  layer is the hardest to test and does not put a single pixel on the screen.

**No chart library, for the reason §13 gives for the graph.** The geometry is
pure and therefore testable, and Recharts or Chart.js would hand back most of
what splitting xterm bought. Measured cost of the whole feature: **+7.0 kB
gzipped JS and +0.7 kB CSS, no new dependency.**

**It renders in the editor, not in a preview pane,** because there is no preview
pane — a note _is_ the markdown you are editing (see `markdown-decorations.ts`).
So a chart is a block widget standing in for the fence while the cursor is
elsewhere. Two consequences worth knowing: the decorations must come from a
`StateField` rather than a `ViewPlugin`, since view plugins may not change the
vertical layout; and the start of a block deliberately does not count as being
inside it, or a note that opens with a chart would show its source until the
cursor moved.

**One block type, two renderings.** `table` and the chart types share a parser
and a spec, so the same data becomes a table or a picture by changing one word.
That is also the accessibility answer: every chart carries a disclosure holding
its own numbers, which is what permits three light-mode series colours that sit
below 3:1 against the page.

**Consequences accepted:**

- Eight series is the ceiling and six slices is the pie's. Past those, the tail
  folds into "Other" rather than generating a hue, because a generated ninth
  colour is indistinguishable from an existing one under colour-vision
  deficiency. The full data stays in the table.
- A bar chart always includes zero; a line chart does not. Bar _length_ encodes
  the value, so a truncated axis misstates every ratio; line _position_ encodes
  it, and forcing zero flattens the trend that was being asked about.
- A pie refuses two value columns, a negative value, and a total of zero rather
  than drawing a confident picture of a false fact.
- The fence keeps the block out of the task list and the graph for free, because
  §12 already skips fenced code. It also costs GitHub's native table rendering:
  inside a fence, a pipe table is legible text rather than a rendered table.

## Open questions

- **Hosting** is undecided. The stack ships as Docker Compose so the box can be
  chosen later.
- **Recurring reminders** are not modelled. A reminder has an optional date and
  nothing else; anything repeating would need syntax that survives round-tripping
  through plain markdown.
- **Notifications** for due reminders do not exist. The reminder list is
  something you look at, not something that arrives.
- **Offline editing** in the desktop app is deferred. Git does most of the work,
  but sync and conflict UI are real effort and not yet justified.
- **Branch protection on the remote** is not enabled, and probably should be.
  The server holds a deploy key with write access, so a compromised box can
  force-push and rewrite the history of the one copy that exists to be the
  backup (§2). Protecting the default branch against force-pushes and deletions
  means the offsite copy cannot be destroyed by the machine most likely to be
  breached. It is a setting on the repository, not something this codebase can
  do for you.
- **Encryption at rest** for the notes on GitHub has not been considered. It
  would answer the plaintext-with-a-third-party point in §2, and it would cost
  the thing that makes the remote useful — `git clone` giving you readable
  markdown on any machine, and GitHub's own web view and search.
