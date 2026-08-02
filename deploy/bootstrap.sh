#!/usr/bin/env bash
#
# Prepares the server host: clones the notes repository and checks the deploy
# key is usable.
#
# Much shorter than it used to be. The previous topology needed a bare hub, a
# post-receive hook and two repositories on this box; with GitHub as the remote
# (DECISIONS §2) the working copy is an ordinary clone and there is nothing to
# wire together.
#
# Safe to re-run: every step checks before it acts.
#
#   ./deploy/bootstrap.sh

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

# .env is the same file docker compose reads, so the two cannot disagree.
if [ -f "$here/.env" ]; then
	set -a
	# shellcheck disable=SC1091
	. "$here/.env"
	set +a
fi

NOTES_DIR="${NOTES_DIR:?set NOTES_DIR in deploy/.env}"
GIT_REMOTE_URL="${GIT_REMOTE_URL:?set GIT_REMOTE_URL in deploy/.env}"
NOTES_BRANCH="${NOTES_BRANCH:-main}"
GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-vim-notes}"
GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-vim-notes@localhost}"
GIT_SSH_KEY_PATH="${GIT_SSH_KEY_PATH:-}"

say() { printf '%s\n' "$*"; }
die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

# --- the deploy key ----------------------------------------------------------

if [ -n "$GIT_SSH_KEY_PATH" ]; then
	[ -f "$GIT_SSH_KEY_PATH" ] || die "no deploy key at $GIT_SSH_KEY_PATH"

	# ssh refuses a key others can read, and reports it in a way that reads like
	# a network problem. Catch it here, where the fix is obvious.
	mode="$(stat -c '%a' "$GIT_SSH_KEY_PATH" 2>/dev/null || stat -f '%Lp' "$GIT_SSH_KEY_PATH")"
	case "$mode" in
	600 | 400) ;;
	*) die "deploy key $GIT_SSH_KEY_PATH is mode $mode; run: chmod 600 $GIT_SSH_KEY_PATH" ;;
	esac

	# The same command the server will use, so a key that works here works there.
	export GIT_SSH_COMMAND="ssh -i '$GIT_SSH_KEY_PATH' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
	say "using deploy key $GIT_SSH_KEY_PATH"
fi

# Never sit at a credential prompt: this may run unattended from a provisioning
# script, and hanging forever is worse than failing.
export GIT_TERMINAL_PROMPT=0

# --- the working copy --------------------------------------------------------

if [ -d "$NOTES_DIR/.git" ]; then
	say "working copy already exists at $NOTES_DIR"

	actual="$(git -C "$NOTES_DIR" remote get-url origin 2>/dev/null || echo '')"
	if [ "$actual" != "$GIT_REMOTE_URL" ]; then
		# Not corrected automatically: repointing somebody's notes at a different
		# repository is not a decision a bootstrap script should make on its own.
		say ""
		say "warning: origin is $actual"
		say "         but GIT_REMOTE_URL is $GIT_REMOTE_URL"
		say "         nothing has been changed; the server reports this at boot too."
		say "         to repoint deliberately:"
		say "             git -C $NOTES_DIR remote set-url origin $GIT_REMOTE_URL"
	fi
else
	say "cloning $GIT_REMOTE_URL into $NOTES_DIR"
	git clone "$GIT_REMOTE_URL" "$NOTES_DIR"

	# A brand new GitHub repository has no commits, so the clone leaves HEAD on
	# whatever this git calls the default branch. Pin it, or the first push
	# creates a second branch alongside the one the laptop uses.
	git -C "$NOTES_DIR" symbolic-ref HEAD "refs/heads/$NOTES_BRANCH"
fi

# The server passes a fallback identity of its own; setting it here means
# anything run by hand in this directory is attributed the same way.
git -C "$NOTES_DIR" config user.name "$GIT_AUTHOR_NAME"
git -C "$NOTES_DIR" config user.email "$GIT_AUTHOR_EMAIL"

# Without an upstream, status() reports ahead/behind as zero whatever the truth
# is -- which makes a server that has stopped pushing look perfectly healthy.
git -C "$NOTES_DIR" config "branch.$NOTES_BRANCH.remote" origin
git -C "$NOTES_DIR" config "branch.$NOTES_BRANCH.merge" "refs/heads/$NOTES_BRANCH"

# --- check it actually works -------------------------------------------------

say ""
if git -C "$NOTES_DIR" ls-remote --quiet --exit-code origin HEAD >/dev/null 2>&1; then
	say "remote reachable: $GIT_REMOTE_URL"
elif git -C "$NOTES_DIR" ls-remote origin >/dev/null 2>&1; then
	# Answered, but has no refs yet. Correct for a new repository, and the first
	# sync will push into it.
	say "remote reachable but empty: $GIT_REMOTE_URL"
else
	die "could not reach $GIT_REMOTE_URL -- check the deploy key has write access"
fi

say ""
say "done."
say ""
say "  working copy $NOTES_DIR"
say "  remote       $GIT_REMOTE_URL"
say ""
say "clone it on your laptop with:"
say ""
say "    git clone $GIT_REMOTE_URL notes"
say ""
say "then start the stack:"
say ""
say "    docker compose -f deploy/docker-compose.yml up -d --build"
