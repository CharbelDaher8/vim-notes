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
# The scan is in Python rather than grep on purpose. BSD grep has no -P, so the
# obvious `grep -qP '[\x00-\x08...]'` fails on macOS -- and with stderr
# suppressed it fails *silently*, reporting every file clean. A guard that
# passes vacuously is worse than no guard, since it also removes the suspicion.
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
