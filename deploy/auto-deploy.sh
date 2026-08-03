#!/usr/bin/env bash
#
# Pull main and redeploy, but only when it has actually moved and only when CI
# says that commit is good.
#
# This polls rather than being pushed to, for the same reason the notes sync
# does (DECISIONS.md §2): the server is tailnet-only, so nothing on the public
# internet can reach it. The alternative -- putting a GitHub runner on the
# tailnet so it can ssh in -- means storing a tailnet credential in GitHub and
# admitting a machine we do not control onto the private network, on every push.
# For a personal notes server that is the worse trade.
#
# The CI gate matters more than it looks. Without it a commit that fails to
# build takes the notes app down until someone notices, and the person who
# notices is someone reaching for their notes.
set -euo pipefail

APP_DIR=${APP_DIR:-/srv/vim-notes/app}
BRANCH=${BRANCH:-main}
REPO=${REPO:-CharbelDaher8/vim-notes}

cd "$APP_DIR"

git fetch -q origin "$BRANCH"
local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse "origin/$BRANCH")

if [ "$local_sha" = "$remote_sha" ]; then
	echo "up to date at ${local_sha:0:7}"
	exit 0
fi

echo "main moved: ${local_sha:0:7} -> ${remote_sha:0:7}"

# Unauthenticated because the code repo is public. At four checks an hour this
# is nowhere near the 60/hour limit for anonymous requests.
#
# `check-runs` rather than the combined `status` endpoint: GitHub Actions
# reports through checks, and the status API would return "pending" forever and
# block every deploy silently.
checks=$(curl -fsSL -H "Accept: application/vnd.github+json" \
	"https://api.github.com/repos/${REPO}/commits/${remote_sha}/check-runs" 2>/dev/null || echo '')

if [ -z "$checks" ]; then
	echo "could not reach the checks API; leaving ${local_sha:0:7} in place"
	exit 0
fi

verdict=$(printf '%s' "$checks" | python3 -c '
import json, sys
runs = json.load(sys.stdin).get("check_runs", [])
if not runs:
    print("none"); raise SystemExit
if any(r["status"] != "completed" for r in runs):
    print("pending"); raise SystemExit
bad = [r["name"] for r in runs if r["conclusion"] not in ("success", "neutral", "skipped")]
print("failed:" + ",".join(bad) if bad else "green")
')

case "$verdict" in
green) ;;
pending)
	# Not an error. The next run picks it up once CI finishes.
	echo "CI still running for ${remote_sha:0:7}; waiting"
	exit 0
	;;
none)
	echo "no checks reported for ${remote_sha:0:7}; refusing to deploy blind"
	exit 0
	;;
*)
	echo "CI ${verdict} for ${remote_sha:0:7}; staying on ${local_sha:0:7}"
	exit 1
	;;
esac

echo "CI green, deploying ${remote_sha:0:7}"
git merge -q --ff-only "origin/$BRANCH"

cd "$APP_DIR/deploy"
docker compose up -d --build

# Images accumulate fast on a 64GB disk when every deploy builds two of them.
docker image prune -f >/dev/null 2>&1 || true

echo "deployed $(git -C "$APP_DIR" log --oneline -1)"
