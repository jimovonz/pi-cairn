#!/usr/bin/env bash
#
# Upgrade the local pi checkout while keeping pi-cairn's patch to it.
#
# Model:
#   main        = pristine mirror of origin/main (fast-forward only)
#   local-cairn = main + local patch commit(s), rebased on every upgrade
#
# This is why the patch is a commit on a branch rather than an edit in the
# working tree: `git rebase` re-merges it with three-way conflict handling,
# and drops it automatically (patch-id match) the moment upstream restores
# the fix. See README.md > patches/.
#
# Usage:  ./upgrade-pi.sh [--dry-run]
# Env:    PI_DIR   path to the pi checkout (default ~/Projects/pi)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_DIR="$REPO/patches"
PI_DIR="${PI_DIR:-$HOME/Projects/pi}"
BRANCH="local-cairn"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }
note() { printf '\n== %s ==\n' "$*"; }

[ -d "$PI_DIR/.git" ] || { echo "no git checkout at $PI_DIR (set PI_DIR)" >&2; exit 1; }
cd "$PI_DIR"

note "fetch origin"
run git fetch origin

note "main -> origin/main (pristine mirror)"
run git checkout main
# npm rewrites lockfile metadata (peer flags) on install; keep main byte-clean.
run git checkout -- package-lock.json 2>/dev/null || true
run git pull --ff-only

note "local-cairn -> rebased onto main"
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
	run git checkout "$BRANCH"
	run git rebase main
else
	run git checkout -b "$BRANCH"
fi

# Guarantee every patch is present. Covers a reset/branchless checkout; on a
# normal upgrade the rebase already carries them and this is a no-op.
shopt -s nullglob
for p in "$PATCH_DIR"/*.patch; do
	name="$(basename "$p")"
	if git apply --reverse --check "$p" >/dev/null 2>&1; then
		echo "ok (already applied): $name"
	elif git apply --check "$p" >/dev/null 2>&1; then
		run git apply --3way "$p"
		run git add -A
		run git commit -m "local(pi-cairn): apply $name"
	else
		echo "!! $name neither applies nor is present" >&2
		echo "   upstream probably changed the region: resolve by hand, then rerun" >&2
		exit 1
	fi
done

note "install + build"
run npm install
run git checkout -- package-lock.json 2>/dev/null || true
run npm run build

note "verify pi-cairn extensions against the new pi"
( cd "$REPO" && run npm run check )

note "done"
echo "pi runs $PI_DIR/packages/coding-agent/dist/cli.js"
echo "smoke test:  pi --version && pi -p 'reply with ok'"
