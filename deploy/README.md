# Deploying vim-notes

A single host running two containers, a bare git hub, and nothing on the public
internet.

```
your laptop ──push──┐
                    │  ssh over tailscale
                    ▼
        ~/notes.git  ── post-receive ──▶ ~/notes
        (bare hub)                       (working copy)
                                              │
                                              │ bind mount
                                              ▼
                    caddy ──────────────▶ server container
              (tailnet address only)     (nvim, git, ripgrep)
```

The hub and the working copy live on the **host**, not in a volume, because
your laptop pushes to the hub over ssh and the hook that follows that push runs
as your user. The containers mount them.

## Bootstrap

```sh
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env            # paths, your uid/gid, your tailnet address

./deploy/bootstrap.sh          # creates the hub + working copy, installs the hook
docker compose -f deploy/docker-compose.yml up -d --build
```

`bootstrap.sh` is safe to re-run; it checks before every step.

Then clone it on the laptop, exactly as the bootstrap output tells you:

```sh
git clone ssh://you@your-host/srv/vim-notes/notes.git notes
```

From then on the laptop is an ordinary clone. `git push` sends notes to the hub
and the working copy follows within the same second; `git pull` collects
whatever you wrote on your phone.

## The three settings that matter

**`BIND_ADDR`** — the host's tailnet address (`tailscale ip -4`). It is the
entire access control story. `/term` is a WebSocket onto a real shell, so
DECISIONS §11 chooses "not reachable" over "reachable behind a password". The
default is `127.0.0.1`, so a missing `.env` fails closed.

**`DOCKER_USER`** — `id -u`:`id -g` of the user that owns the notes directory.
The hook runs on the host as you and the container writes the same files; if
the uids differ, git refuses the repository as owned by someone else.

**`NOTES_DIR` / `HUB_DIR`** — absolute host paths, mounted into the container at
_the same paths_. `notes/.git/config` records `origin` as an absolute path, and
that one file is read from both the host and the container, so the hub has to
be at one address that works for both.

## Making it public later

Deliberately not a rewrite, but deliberately not one setting either. It takes
both of:

1. `BIND_ADDR=0.0.0.0` and a real hostname in `deploy/.env`.
2. A site block in the `Caddyfile` with `tls` and an authentication handler in
   front of `/term/ws`, plus deleting `auto_https off`.

Doing only the first publishes a shell. The Caddyfile marks the spot.

## The post-receive hook

`hub/post-receive` fast-forwards the working copy after a push. Its whole design
is that it is allowed to give up:

- **Working copy dirty?** It does nothing. The server's auto-committer is
  probably mid-write, and stashing under a live editor loses paragraphs.
- **Working copy has its own commits?** It does nothing. `--ff-only` refuses,
  and the server's `sync()` rebases and pushes them properly.
- **Anything else fails?** It still exits 0. The refs are already updated by the
  time the hook runs, so reporting failure would be a lie about the push.

It never stashes, never `reset --hard`, and never rebases — a rebase would leave
conflict markers on disk that the auto-committer would then commit as the note's
content.

Run `./deploy/test-hook.sh` to check it against real repositories in a temp
directory: it covers a clean fast-forward, an uncommitted edit surviving a push,
local commits surviving a push, and a branch deletion checking nothing out.

## Routes the proxy has to know about

Caddy forwards two paths to the server and serves everything else from the
built client:

| Path       | Goes to     | Note                                    |
| ---------- | ----------- | --------------------------------------- |
| `/term/ws` | server:4321 | the terminal WebSocket, matched exactly |
| `/trpc/*`  | server:4321 | the API                                 |
| everything | `/srv/web`  | SPA, with a fallback to `index.html`    |

`/term/ws` is matched as an exact path rather than as a `/term/*` prefix, because
`/term` is _also_ a client-side route — the page that hosts xterm.js. A prefix
match would send that page request to the WebSocket endpoint and never serve the
app. If either path changes on the server, this is the file that has to change
with it, and the failure is silent in both directions.

## Notes on the images

**nvim comes from the official release tarball**, not from Debian, whose nvim is
old enough that a modern `init.lua` will not load. Pin `NVIM_RELEASE` in the
Dockerfile to a tag rather than `stable` if you want rebuilds to be reproducible.

**The server bundle inlines `@vim-notes/core`.** tsup treats workspace packages
as external, and core's entry is `./src/index.ts`, so without `noExternal` the
build produces a bundle that asks plain `node` to import TypeScript — the image
would exit on its first import. That is handled in
`packages/server/tsup.config.ts`, so the normal build script is all this
Dockerfile needs. node-pty stays external, being a native module.

**`nvim-state` is a named volume.** Plugins, shada and undo history live there.
None of it is worth backing up — your notes are in git, which is the point.

## Backups

The hub is the thing to back up, and `git clone --mirror` is the whole job:

```sh
git clone --mirror /srv/vim-notes/notes.git notes-backup.git
```

Every clone is already a full backup, so a laptop that pulls regularly is one
too. The GitHub mirror in DECISIONS' open questions would make this automatic.
