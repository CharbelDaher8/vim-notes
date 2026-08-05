# Deploying vim-notes

A single host running two containers, a clone of a private GitHub repository,
and nothing on the public internet.

```
your laptop ──push──┐                    ┌──── pull/push every 60s
                    ▼                    ▼
            github.com/you/notes (private)
                    ▲
                    │  deploy key, ssh
                    │
        ~/notes  ───┘   server working copy (an ordinary clone)
            │
            │ bind mount
            ▼
   caddy ──────────▶ server container
 (tailnet only)      (nvim, git, ripgrep)
```

The notes directory lives on the **host** and is bind-mounted, so you can work
in it directly over ssh as well as through the app.

## Bootstrap

Create a **private** repository on GitHub first — empty is fine, the first sync
pushes into it.

```sh
ssh-keygen -t ed25519 -N '' -C vim-notes -f /srv/vim-notes/deploy-key
chmod 600 /srv/vim-notes/deploy-key
cat /srv/vim-notes/deploy-key.pub
```

Add that public key to the repository under **Settings → Deploy keys → Add
deploy key**, with **Allow write access** ticked. Then:

```sh
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env            # repo URL, key path, uid/gid, tailnet address

./deploy/bootstrap.sh          # clones the repo and checks the key works
docker compose -f deploy/docker-compose.yml up -d --build
```

`bootstrap.sh` is safe to re-run and checks before every step. On the laptop:

```sh
git clone git@github.com:you/notes.git notes
```

From then on both are ordinary clones. `git push` sends notes to GitHub; the
server picks them up on its next poll.

## Why a deploy key rather than a token

A deploy key is scoped to **one repository**, which a personal access token is
not — a classic PAT can reach everything the account can, and even a fine-grained
one is an account credential pointed at a repo. It also does not expire, so sync
does not silently stop working in a year.

The practical difference is where the secret ends up. An HTTPS token has to be
embedded in the remote URL or a credential file, which writes it into
`notes/.git/config` — inside the notes directory, which is the thing being
backed up and cloned around. The deploy key stays a mounted file that nothing
copies.

`GIT_TERMINAL_PROMPT=0` is set for every git subprocess, so a missing or
rejected credential fails immediately instead of hanging on a password prompt
nobody is there to answer.

**Host keys** are trusted on first use (`StrictHostKeyChecking=accept-new`) and
recorded in `/state/known_hosts` in the `nvim-state` volume. To pin them
instead, `ssh-keyscan github.com > known_hosts`, mount that file read-only, and
point `GIT_KNOWN_HOSTS_PATH` at it — stronger, at the cost of breaking when
GitHub rotates a key.

## Syncing

The server polls: `SYNC_INTERVAL_MS`, default 60s, minimum 5s, `0` to disable.

Polling rather than a webhook because the server is tailnet-only and GitHub
cannot reach it — the honest cost of the topology in DECISIONS §2, and the one
thing the old bare-hub setup did better.

Each cycle flushes any pending auto-commit first, then calls `sync()`
(fetch → rebase → push). Failures are classified rather than retried blindly:

| Outcome                         | What the scheduler does                    |
| ------------------------------- | ------------------------------------------ |
| `dirty`                         | retries next cycle; a save landed mid-sync |
| `network`, `rejected`           | backs off, doubling to a 30 minute ceiling |
| `auth`, `conflict`, `no-remote` | backs off and logs loudly — needs a human  |

Nothing stops the loop. A failure is logged once and not repeated until the
situation changes, because a log that repeats itself is one people stop reading.

## The three settings that matter

**`BIND_ADDR`** — the host's tailnet address (`tailscale ip -4`). It is the
entire access control story. `/term` is a WebSocket onto a real shell, so
DECISIONS §11 chooses "not reachable" over "reachable behind a password". The
default is `127.0.0.1`, so a missing `.env` fails closed.

**`DOCKER_USER`** — `id -u`:`id -g` of the user that owns the notes directory
and can read the deploy key. Git refuses a repository owned by someone else.

**`GIT_REMOTE_URL`** — where notes are pushed. Note that `bootstrap.sh` only
clones when the directory is absent, so **editing this afterwards does nothing**
on its own; the server reports the disagreement at boot, and repointing is a
deliberate `git remote set-url`.

## Making it public later

Deliberately not a rewrite, but deliberately not one setting either. It takes
both of:

1. `BIND_ADDR=0.0.0.0` and a real hostname in `deploy/.env`.
2. A site block in the `Caddyfile` with `tls` and an authentication handler in
   front of `/term/ws`, plus deleting `auto_https off`.

Doing only the first publishes a shell. The Caddyfile marks the spot.

## Routes the proxy has to know about

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

## What the server checks at boot

`packages/server/src/preflight.ts` runs before the first request and reports:

- `git`, `rg` and nvim — resolved path and version. Missing git is fatal;
  the other two degrade with a warning.
- The notes root exists, is writable, and is **the root of its own repository**
  rather than a subdirectory of another one.
- `origin` is configured, answers, and matches `GIT_REMOTE_URL`.

Remote problems are warnings, not refusals: a box should still serve its own
notes while GitHub is down.

## Notes on the images

**nvim comes from the official release tarball**, not from Debian, whose nvim is
old enough that a modern `init.lua` will not load. Pin `NVIM_RELEASE` in the
Dockerfile to a tag rather than `stable` if you want reproducible rebuilds.

**`openssh-client` is installed deliberately.** Git does not bundle ssh, and
without it every push fails with a message about a missing transport.

**`nvim-state` is a named volume.** Plugins, shada, undo history and the ssh
known_hosts file live there. None of it is worth backing up.

**A compiler is in the runtime image, on purpose.** `build-essential` and `fd`
are there for the nvim config, not the server: `telescope-fzf-native` has
`build = "make"` and `nvim-treesitter` compiles a parser the first time it meets
a new filetype. Both happen at runtime inside the container, so a build-stage
toolchain would not help. It costs about 250MB. `lazygit` is there for the same
reason — `<leader>gg` opens it — and earns its keep besides, since this box
auto-commits every save and lazygit is the quickest way to see what that did.

## The nvim config

`deploy/nvim-config/` is a **copy of `~/.config/nvim`**, committed so it deploys
with everything else. Mounted read-only at `/config/nvim`, which
`XDG_CONFIG_HOME=/config` makes nvim read exactly as it would `~/.config/nvim`.

The copy is the thing to be careful about: nothing syncs it. Editing it here
does not change your laptop, and editing your laptop does not change the box
until you copy it over and push:

```sh
rsync -a --delete --exclude .DS_Store ~/.config/nvim/ deploy/nvim-config/
```

Two consequences worth knowing:

- **The mount is read-only**, so a plugin manager that wants to write into
  `~/.config/nvim` fails loudly rather than half-succeeding. Plugins install
  into `~/.local/share/nvim`, which `XDG_DATA_HOME` points at the writable
  `nvim-state` volume, so lazy.nvim and Mason work normally.
- **vim-notes is a public repository.** This config carries no secrets today,
  and it is worth rechecking before you paste an API key for some AI plugin
  into it. If that ever changes, point `NVIM_CONFIG_DIR` in `deploy/.env` at a
  private checkout instead and this directory stops being used.

Anything the config shells out to has to exist in the image — `/term` is a
shell (DECISIONS §3), so the way to check is to type the command and see.

## The daily refresh

`refresh` fetches 29 sources and runs the LLM pass, which takes minutes and
costs tokens, so it is a scheduled job rather than something the API does on
demand. The units live here and are installed once:

```sh
sudo cp deploy/vim-notes-news.service deploy/vim-notes-news.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vim-notes-news.timer

systemctl list-timers vim-notes-news.timer   # when it next fires
journalctl -u vim-notes-news -n 50           # what the last run did
sudo systemctl start vim-notes-news.service  # run one now
```

It fires at **06:00 Lebanon time**, written as `Asia/Beirut` rather than a UTC
offset so it stays at six through daylight saving — 03:00 UTC in summer, 04:00
in winter. `Persistent=true` means a box that was asleep at six refreshes once
when it wakes rather than skipping the day.

The only thing it needs that the API does not is `CLAUDE_CODE_OAUTH_TOKEN`. A
run with no token, or an expired one, fails the unit and leaves the feed
exactly as it was — the reader keeps serving what is already stored.

## Backups

The whole point of §2: GitHub is the offsite copy, and every clone is a complete
one. To take another:

```sh
git clone --mirror git@github.com:you/notes.git notes-backup.git
```

A laptop that pulls regularly is already a full backup.
