#!/usr/bin/env bash
# Link this repo's extensions into pi's global auto-discovery directory.
# Idempotent: re-run after cloning on a new machine.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ED="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
mkdir -p "$ED"

for src in "$REPO"/extensions/*.ts; do
	[ -e "$src" ] || continue
	name="$(basename "$src")"
	dst="$ED/$name"
	if [ -e "$dst" ] && [ ! -L "$dst" ]; then
		echo "SKIP  $dst already exists and is not a symlink — move it away and re-run" >&2
		continue
	fi
	ln -sfn "$src" "$dst"
	echo "LINK  $dst -> $src"
done

echo "Done. Start pi (or run /reload inside a session) to pick them up."
