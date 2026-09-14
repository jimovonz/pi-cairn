#!/usr/bin/env bash
#
# Install the pi-cairn extensions into a pi installation.
#
# Registration is by ABSOLUTE PATH in ~/.pi/agent/settings.json, not by symlinking
# into ~/.pi/agent/extensions. That is not a stylistic choice:
#
#   jiti resolves an extension's imports relative to the path it was loaded from,
#   WITHOUT dereferencing symlinks. Load a symlinked extension and every bare import
#   ("typebox") and every relative import ("../lib/bridge.ts") is resolved against
#   the symlink's directory, where neither exists. Verified: loading via a symlink
#   fails with "Cannot find module 'typebox'" while the identical file loaded by its
#   real path works.
#
# Registering the real path keeps this repo as the single source of truth -- nothing
# of value lives inside the pi checkout -- while letting module resolution work.
# The order of the array is the load order, which matters because handlers returning
# systemPrompt from before_agent_start are chained and the tool_call pipeline must
# run RTK before the CCM wrap.
#
# Usage:  ./install.sh [--uninstall]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$AGENT_DIR/settings.json"

# Load order is significant; keep cairn before routing.
EXTENSIONS=("$REPO/extensions/cairn.ts" "$REPO/extensions/routing.ts" "$REPO/extensions/graph.ts")

MODE="install"
[[ "${1:-}" == "--uninstall" ]] && MODE="uninstall"

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

if [[ "$MODE" == "install" ]]; then
	echo "Dependencies:"
	need python3
	need pi
	need_file "${CAIRN_HOME:-$HOME/Projects/cairn}/hooks/pi_bridge.py" pi_bridge.py
	need_file "${CAIRN_HOME:-$HOME/Projects/cairn}/cairn/query.py" query.py
	need_file "$REPO/node_modules/typebox" typebox
	# The routing layer calls the CCH interceptors by absolute path, and they in turn
	# invoke cache-wrap.py by its own resolved path -- neither needs to be on PATH.
	need_file "${CCH_HOME:-$HOME/Projects/claude-context-hooks}/hooks/intercept-bash.py" intercept-bash.py
	# Optional: only the routing layer needs these, and it is off by default.
	for opt in rtk cairn-graph ccm-get.py; do
		if command -v "$opt" >/dev/null 2>&1; then
			printf '  ok    %-16s %s\n' "$opt" "$(command -v "$opt")"
		else
			printf '  warn  %-16s absent (PI_ROUTING/PI_RTK degrade to no-ops)\n' "$opt"
		fi
	done
	# Retrieval is ~10x slower without the embedding daemon: each call loads
	# sentence-transformers from scratch (~8.0s) instead of hitting the resident
	# socket (~0.7s). Not fatal, but PI_CAIRN is painful without it.
	if python3 "${CAIRN_HOME:-$HOME/Projects/cairn}/cairn/daemon.py" status 2>/dev/null | grep -qi healthy; then
		printf '  ok    %-16s serving healthy\n' "cairn daemon"
	else
		printf '  warn  %-16s NOT running: retrieval costs ~8s per prompt instead of ~0.7s\n' "cairn daemon"
		printf '        start it: python3 %s/cairn/daemon.py start\n' "${CAIRN_HOME:-$HOME/Projects/cairn}"
	fi

	if [[ $fail -ne 0 ]]; then
		echo
		echo "Required dependencies are missing. Nothing was installed." >&2
		[[ -d "$REPO/node_modules/typebox" ]] || echo "Hint: run 'npm install' in $REPO first." >&2
		exit 1
	fi
	echo
fi

mkdir -p "$AGENT_DIR"

# Merge into settings.json rather than overwriting: the file holds the user's model
# choice, provider config and package list, none of which we own.
MODE="$MODE" SETTINGS="$SETTINGS" python3 - "${EXTENSIONS[@]}" <<'PY'
import json, os, sys

settings_path = os.environ["SETTINGS"]
mode = os.environ["MODE"]
ours = [p for p in sys.argv[1:] if mode == "uninstall" or os.path.exists(p)]

try:
    with open(settings_path, encoding="utf-8") as f:
        settings = json.load(f)
    if not isinstance(settings, dict):
        raise ValueError("settings.json is not a JSON object")
except FileNotFoundError:
    settings = {}
except (ValueError, OSError) as exc:
    sys.exit(f"Refusing to touch {settings_path}: {exc}")

existing = settings.get("extensions") or []
if not isinstance(existing, list):
    sys.exit(f"Refusing to touch {settings_path}: 'extensions' is not a list")

# Drop any previous registration of ours, then re-add in declared order. Idempotent,
# and it repairs ordering if the array drifted.
kept = [e for e in existing if e not in ours]
settings["extensions"] = kept if mode == "uninstall" else kept + ours

if not settings["extensions"]:
    settings.pop("extensions")

tmp = settings_path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
os.replace(tmp, settings_path)

verb = "Unregistered" if mode == "uninstall" else "Registered"
print(f"{verb} in {settings_path}:")
for path in ours:
    print(f"  {path}")
PY

if [[ "$MODE" == "uninstall" ]]; then
	echo
	echo "Uninstalled. The repo itself is untouched."
	exit 0
fi

cat <<'NOTE'

Every layer is OFF by default; enable what you want:

  export PI_CAIRN=1      # memory: retrieval, capture, the [cm] gate, cairn_query
  export PI_ROUTING=1    # deny+suggest routing of read/grep/find/ls
  export PI_CCM=1        # wrap bash in cache-wrap.py (stubs, graph footer, rules)
  export PI_RTK=1        # rewrite bash commands through rtk
  export PI_GRAPH=1      # expose the code_graph lookup tool to the model

Try a layer without registering it (use a real path, never a symlink):

  pi -p -e ./extensions/cairn.ts "hello"
NOTE
