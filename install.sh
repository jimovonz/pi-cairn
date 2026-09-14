#!/usr/bin/env bash
#
# Install the pi-cairn extensions into a pi installation.
#
# pi discovers extensions in ~/.pi/agent/extensions (global) and .pi/extensions
# (project, trusted only), one level deep, and FOLLOWS SYMLINKS. So we symlink out
# of this repo rather than copying: the repo stays the single source of truth, and
# nothing of value ever lives only inside the pi checkout -- which is exactly how
# the previous port was lost.
#
# Link names carry a numeric prefix to make load order deterministic. Order matters
# because every extension returning `systemPrompt` from before_agent_start is
# chained, and the tool_call pipeline must run RTK before the CCM wrap (the same
# ordering CCH's own installer enforces for PreToolUse:Bash).
#
# Usage:  ./install.sh [--uninstall]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXT_DIR="$AGENT_DIR/extensions"

# link name -> source file. The numeric prefix fixes load order.
declare -A LINKS=(
	["10-cairn.ts"]="$REPO/extensions/cairn.ts"
	["20-routing.ts"]="$REPO/extensions/routing.ts"
)

if [[ "${1:-}" == "--uninstall" ]]; then
	for name in "${!LINKS[@]}"; do
		if [[ -L "$EXT_DIR/$name" ]]; then
			rm "$EXT_DIR/$name"
			echo "removed  $EXT_DIR/$name"
		fi
	done
	echo "Uninstalled. The repo itself is untouched."
	exit 0
fi

fail=0
need() {
	if command -v "$1" >/dev/null 2>&1; then
		printf '  ok    %-16s %s\n' "$1" "$(command -v "$1")"
	else
		printf '  MISS  %-16s not on PATH\n' "$1"
		fail=1
	fi
}
need_file() {
	if [[ -e "$1" ]]; then
		printf '  ok    %-16s %s\n' "$2" "$1"
	else
		printf '  MISS  %-16s %s\n' "$2" "$1"
		fail=1
	fi
}

echo "Dependencies:"
need python3
need pi
need_file "${CAIRN_HOME:-$HOME/Projects/cairn}/hooks/pi_bridge.py" pi_bridge.py
need_file "${CAIRN_HOME:-$HOME/Projects/cairn}/cairn/query.py" query.py
# Optional -- only the routing layer needs these, and it is off by default.
for opt in rtk cairn-graph cache-wrap.py ccm-get.py; do
	if command -v "$opt" >/dev/null 2>&1; then
		printf '  ok    %-16s %s\n' "$opt" "$(command -v "$opt")"
	else
		printf '  warn  %-16s absent (routing layer will stay disabled)\n' "$opt"
	fi
done

if [[ $fail -ne 0 ]]; then
	echo
	echo "Required dependencies are missing. Nothing was installed." >&2
	exit 1
fi

mkdir -p "$EXT_DIR"
echo
echo "Linking into $EXT_DIR:"
for name in "${!LINKS[@]}"; do
	src="${LINKS[$name]}"
	if [[ ! -f "$src" ]]; then
		printf '  skip  %-16s (not built yet)\n' "$name"
		continue
	fi
	ln -sfn "$src" "$EXT_DIR/$name"
	printf '  link  %-16s -> %s\n' "$name" "$src"
done

cat <<'NOTE'

Installed. Every layer is OFF by default; enable what you want:

  export PI_CAIRN=1      # memory: retrieval, capture, the [cm] gate, cairn_query
  export PI_ROUTING=1    # deny+suggest routing of read/grep/find/ls
  export PI_CCM=1        # wrap bash in cache-wrap.py (stubs, graph footer, rules)
  export PI_RTK=1        # rewrite bash commands through rtk

Verify without installing anything:  pi -p -e ./extensions/cairn.ts "hello"
NOTE
