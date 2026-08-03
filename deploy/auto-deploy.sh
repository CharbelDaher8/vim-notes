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
#
# It gates on the *tip* commit and then fast-forwards to it, so every commit in
# between arrives having been verified only by whatever ran on the tip. That is
# the honest limit of this design: the gate keeps a broken HEAD out, not a
# broken history. Deploying each commit in turn would fix it and is not worth
# the build minutes for a personal notes server.
set -euo pipefail

APP_DIR=${APP_DIR:-/srv/vim-notes/app}
BRANCH=${BRANCH:-main}
REPO=${REPO:-CharbelDaher8/vim-notes}

# The news aggregator, checked out beside the app and built by the same compose
# file. Updated here rather than by its own timer so that one deploy moves the
# whole stack: two timers would mean the notes server could be talking to an API
# from a different afternoon, with nothing saying so.
NEWS_DIR=${NEWS_DIR:-/srv/vim-notes/news}


# Which compose profiles apply, as a string for word splitting. Empty when there
# is no news checkout, so a box without one builds exactly what it did before.
news_profile() {
	# An `if` rather than `[ ... ] && printf`, so the function cannot return
	# non-zero merely for saying "no profiles". Under `set -e` that is the kind
	# of thing that works until the day it is called somewhere it matters.
	if [ -d "$NEWS_DIR/.git" ]; then
		printf -- "--profile news"
	fi
}

# Bring the stack in line with the compose file without rebuilding anything.
# Used on the no-change path; the deploy path below does the same with --build.
reconcile() {
	cd "$APP_DIR/deploy" || return 0
	# shellcheck disable=SC2086
	docker compose $(news_profile) up -d
}

# The news checkout, if it is there. Deliberately not fatal and deliberately not
# gated on its own CI: it is a separate repository with a separate history, and
# a fetch that fails should hold back the news pane, not the notes.
update_news() {
	[ -d "$NEWS_DIR/.git" ] || { echo "no news checkout at ${NEWS_DIR}; skipping the news service"; return 0; }

	(
		cd "$NEWS_DIR"
		before=$(git rev-parse --short HEAD)
		git fetch -q origin "$BRANCH" && git merge -q --ff-only "origin/$BRANCH"
		after=$(git rev-parse --short HEAD)
		if [ "$before" = "$after" ]; then
			echo "news up to date at ${before}"
		else
			echo "news moved: ${before} -> ${after}"
		fi
	) || echo "could not update the news checkout; building whatever is on disk"
}

cd "$APP_DIR"

git fetch -q origin "$BRANCH"
local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse "origin/$BRANCH")

if [ "$local_sha" = "$remote_sha" ]; then
	echo "up to date at ${local_sha:0:7}"
	# Not `exit 0`, which is what this used to do and was wrong in a way that
	# only showed up the day a second service appeared: `compose up -d` is how
	# the stack is *reconciled*, not merely how new code is rolled out, and
	# returning here meant a service that had never been started could never
	# start. Cloning the news repository changed nothing until an unrelated
	# commit landed on main and dragged it in.
	#
	# Cheap enough for a 15-minute timer: with nothing to do it is about a
	# second, and no `--build`, so unchanged images are not rebuilt. It also
	# means a service somebody stopped by hand comes back on the next tick.
	reconcile
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

# Checks whose name ends with "(advisory)" report something worth seeing and
# not worth blocking on. Today that is the pty delivery pair: they assert a
# platform behaviour this repository cannot fix, they were red in 15 of 25
# runs, and every one of those runs was a deploy that could not happen for a
# fault already documented at length. See .github/workflows/ci.yml, which is
# where the name is set, and pty-delivery-gate.ts for the reasoning.
#
# A suffix rather than a list of names, so adding another one is a rename in
# the workflow rather than an edit here that somebody has to remember.
ADVISORY = "(advisory)"

runs = [r for r in json.load(sys.stdin).get("check_runs", [])
        if not r["name"].strip().endswith(ADVISORY)]
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

update_news

cd "$APP_DIR/deploy"
# shellcheck disable=SC2086
docker compose $(news_profile) up -d --build
