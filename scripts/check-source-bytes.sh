#!/usr/bin/env bash
#
# Fail if any source file contains a literal NUL byte -- almost always a `\0`
# written into a template literal where an escape sequence was meant.
#
# This has happened four times in this repository, in four different files, and
# it is nastier than it sounds: NUL in the first few kilobytes is exactly how
# git decides a file is binary, so it stops showing diffs for it entirely. The
# code runs correctly, the tests pass, and every subsequent change to that file
# becomes invisible in review.
#
# Only NUL. Other control bytes are deliberately allowed: the terminal tests
# carry ESC and BEL as fixture data, which is the whole point of them, and none
# of those affect git's binary heuristic.
#
# The scan is a real program rather than a grep one-liner on purpose, and this
# is the part worth reading before you "simplify" it.
#
# Two people wrote this check independently in one afternoon. Both reached for
# grep. Both got a silently wrong answer, in opposite directions:
#
#   grep -qP '[\x00...]'   BSD grep has no -P. With stderr redirected it fails
#                          silently and reports every file CLEAN.
#   grep -qU $'\000'       A NUL cannot survive as a shell argument, so the
#                          pattern arrives empty and matches EVERYTHING --
#                          reporting every file DIRTY.
#
# The common cause is that the byte being searched for is the one byte that
# cannot be passed through a shell argument. So the pattern has to live inside
# a program that reads bytes directly, never on a command line.
#
# A guard that passes vacuously is worse than no guard, because it also removes
# the suspicion that would have made someone look.
set -euo pipefail

cd "$(dirname "$0")/.."

# Tracked files plus anything new that is not ignored, so a NUL is caught before
# it is committed rather than after.
git ls-files -z --cached --others --exclude-standard 'packages/*/src/*' 'scripts/*' \
	| python3 -c '
import sys

offenders = []
for path in sys.stdin.buffer.read().split(b"\0"):
    if not path:
        continue
    name = path.decode("utf8", "replace")
    try:
        data = open(name, "rb").read()
    except (IsADirectoryError, FileNotFoundError):
        continue
    count = data.count(0)
    if count:
        offenders.append((name, count))

if offenders:
    print("Literal NUL bytes found in source:\n", file=sys.stderr)
    for name, count in offenders:
        print(f"  {name}  ({count})", file=sys.stderr)
    print(
        "\nAlmost certainly `\\0` where `\\u0000` was meant."
        "\nGit treats such a file as binary and stops diffing it.",
        file=sys.stderr,
    )
    sys.exit(1)

print("source byte check: clean")
'
