#!/usr/bin/env bash
#
# Creates the git topology from DECISIONS §2 on the server host: a bare hub, a
# working copy cloned from it, and the post-receive hook that keeps the second
# following the first.
#
# Runs on the host rather than in a container, because the hub is what your
# laptop pushes to over ssh and the hook has to run as the user that owns the
# files. Safe to re-run: every step checks before it acts.
#
#   ./deploy/bootstrap.sh                       # uses deploy/.env
#   NOTES_DIR=/srv/notes HUB_DIR=/srv/notes.git ./deploy/bootstrap.sh

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

# .env is the same file docker compose reads, so the paths cannot drift apart.
if [ -f "$here/.env" ]; then
	set -a
	# shellcheck disable=SC1091
	. "$here/.env"
	set +a
fi

NOTES_DIR="${NOTES_DIR:?set NOTES_DIR in deploy/.env}"
HUB_DIR="${HUB_DIR:?set HUB_DIR in deploy/.env}"
NOTES_BRANCH="${NOTES_BRANCH:-main}"
GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-vim-notes}"
GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-vim-notes@localhost}"

say() { printf '%s\n' "$*"; }

# --- the hub -----------------------------------------------------------------

if [ -d "$HUB_DIR" ]; then
	say "hub already exists at $HUB_DIR"
else
	say "creating bare hub at $HUB_DIR"
	git init --quiet --bare -b "$NOTES_BRANCH" "$HUB_DIR"
fi

# Refuse a push that would discard history. The hub is the only copy every other
# clone agrees on, and until the GitHub mirror in DECISIONS' open questions
# exists it is also the only offsite one, so a force-push into it is almost
# always a mistake made at 2am rather than an intention.
#
# Branch *deletion* is left allowed on purpose: `receive.denyDeletes` would also
# block tidying up a scratch branch, which is a normal thing to want, and losing
# main to an accidental delete is not a plausible slip.
git -C "$HUB_DIR" config receive.denyNonFastForwards true

# How the hook finds the working copy. A push arrives over ssh with none of the
# pusher's environment, so this has to be recorded rather than exported.
git -C "$HUB_DIR" config notes.worktree "$NOTES_DIR"

say "installing post-receive hook"
install -m 0755 "$here/hub/post-receive" "$HUB_DIR/hooks/post-receive"

# --- the working copy --------------------------------------------------------

if [ -d "$NOTES_DIR/.git" ]; then
	say "working copy already exists at $NOTES_DIR"
else
	say "cloning working copy to $NOTES_DIR"
	git clone --quiet "$HUB_DIR" "$NOTES_DIR" 2>/dev/null

	# Cloning an empty hub leaves HEAD wherever the local git's default branch
	# points, which is not necessarily $NOTES_BRANCH.
	git -C "$NOTES_DIR" symbolic-ref HEAD "refs/heads/$NOTES_BRANCH"
fi

# The server passes a fallback identity of its own, but setting it here means
# anything you run by hand in this directory is attributed the same way.
git -C "$NOTES_DIR" config user.name "$GIT_AUTHOR_NAME"
git -C "$NOTES_DIR" config user.email "$GIT_AUTHOR_EMAIL"

# Without this the first sync has no upstream to compare against, and status()
# reports ahead/behind as zero regardless of the truth.
git -C "$NOTES_DIR" config "branch.$NOTES_BRANCH.remote" origin
git -C "$NOTES_DIR" config "branch.$NOTES_BRANCH.merge" "refs/heads/$NOTES_BRANCH"

say
say "done."
say
say "  hub          $HUB_DIR"
say "  working copy $NOTES_DIR"
say
say "clone it on your laptop with:"
say
say "    git clone ssh://$(whoami)@$(hostname)$HUB_DIR notes"
say
say "then start the stack:"
say
say "    docker compose -f deploy/docker-compose.yml up -d --build"
