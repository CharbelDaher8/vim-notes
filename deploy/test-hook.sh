#!/usr/bin/env bash
#
# Exercises hub/post-receive against real repositories in a temp directory.
#
# The hook is the one piece of this deploy stack with interesting behaviour, and
# it runs unattended on a directory holding the only copy of someone's notes.
# The failure modes that matter -- clobbering uncommitted work, discarding local
# commits, operating on the hub because GIT_DIR was still set -- are all silent.
# So they get a test rather than a careful reading.
#
# Needs nothing but git and a POSIX shell. Run it directly: ./deploy/test-hook.sh

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/hub/post-receive"
PLAYGROUND="$(mktemp -d)"
trap 'rm -rf "$PLAYGROUND"' EXIT

# The developer's own gitconfig must not decide how these repositories behave.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null LC_ALL=C

HUB="$PLAYGROUND/notes.git"
SERVER="$PLAYGROUND/notes"
LAPTOP="$PLAYGROUND/laptop"

# Deliberately NOT set: the hook is left to find the working copy through the
# hub's own config, which is the path production actually uses. A push over ssh
# carries none of the pusher's environment, so testing the env override would
# test the one mechanism that is guaranteed not to be in play.

failures=0

check() {
	local label="$1" expected="$2" actual="$3"
	if [ "$expected" = "$actual" ]; then
		printf '  ok   %s\n' "$label"
	else
		printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$label" "$expected" "$actual"
		failures=$((failures + 1))
	fi
}

setup() {
	rm -rf "$HUB" "$SERVER" "$LAPTOP"

	git init --quiet --bare -b main "$HUB"
	install -m 0755 "$HOOK" "$HUB/hooks/post-receive"
	# What bootstrap.sh does in production, and how the hook finds the tree.
	git -C "$HUB" config notes.worktree "$SERVER"

	git clone --quiet "$HUB" "$LAPTOP" 2>/dev/null
	git -C "$LAPTOP" config user.name Laptop
	git -C "$LAPTOP" config user.email laptop@example.test
	git -C "$LAPTOP" symbolic-ref HEAD refs/heads/main

	echo 'first note' >"$LAPTOP/note.md"
	git -C "$LAPTOP" add -A
	git -C "$LAPTOP" commit --quiet -m 'first note'
	git -C "$LAPTOP" push --quiet origin main 2>/dev/null

	git clone --quiet "$HUB" "$SERVER"
	git -C "$SERVER" config user.name Server
	git -C "$SERVER" config user.email server@example.test
}

laptop_push() {
	echo "$2" >"$LAPTOP/$1"
	git -C "$LAPTOP" add -A
	git -C "$LAPTOP" commit --quiet -m "laptop: $1"
	git -C "$LAPTOP" push --quiet origin main 2>/dev/null
}

echo 'post-receive: a clean working copy follows the hub'
setup
laptop_push second.md 'from the laptop'
check 'working copy received the pushed file' 'from the laptop' "$(cat "$SERVER/second.md" 2>/dev/null || echo MISSING)"
check 'working copy is on the hub commit' \
	"$(git -C "$HUB" rev-parse main)" "$(git -C "$SERVER" rev-parse HEAD)"

echo
echo 'post-receive: uncommitted work is never touched'
setup
echo 'half-typed paragraph' >"$SERVER/note.md"
laptop_push third.md 'from the laptop'
check 'uncommitted edit survived' 'half-typed paragraph' "$(cat "$SERVER/note.md")"
check 'working copy was left behind the hub' 'behind' \
	"$([ "$(git -C "$HUB" rev-parse main)" = "$(git -C "$SERVER" rev-parse HEAD)" ] && echo same || echo behind)"
check 'no merge or rebase was left in progress' 'clean' \
	"$([ -d "$SERVER/.git/rebase-merge" ] || [ -f "$SERVER/.git/MERGE_HEAD" ] && echo dirty || echo clean)"

echo
echo 'post-receive: local commits are never discarded'
setup
echo 'written on the server' >"$SERVER/server.md"
git -C "$SERVER" add -A
git -C "$SERVER" commit --quiet -m 'server note'
server_head="$(git -C "$SERVER" rev-parse HEAD)"
laptop_push fourth.md 'from the laptop'
check 'server commit still reachable' 'reachable' \
	"$(git -C "$SERVER" cat-file -e "$server_head" 2>/dev/null && echo reachable || echo gone)"
check 'server HEAD unchanged' "$server_head" "$(git -C "$SERVER" rev-parse HEAD)"
check 'server file still present' 'written on the server' "$(cat "$SERVER/server.md")"

echo
echo 'post-receive: a branch deletion checks nothing out'
setup
git -C "$LAPTOP" push --quiet origin :refs/heads/scratch 2>/dev/null || true
git -C "$LAPTOP" push --quiet origin main:refs/heads/scratch 2>/dev/null
git -C "$LAPTOP" push --quiet origin --delete scratch 2>/dev/null
check 'working copy survived a branch delete' 'first note' "$(cat "$SERVER/note.md")"

echo
if [ "$failures" -eq 0 ]; then
	echo 'all post-receive checks passed'
else
	echo "$failures check(s) failed"
	exit 1
fi
