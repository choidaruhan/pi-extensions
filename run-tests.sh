#!/usr/bin/env bash
# Headless suite for these extensions: no TUI, no model calls.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

status=0
step() {
	local label="$1"
	shift
	printf '\n── %s\n' "$label"
	"$@" || status=1
}

step "truncateThinking unit" node tests/truncate-thinking.test.mjs
step "TUI render (real component)" node tests/render.test.mjs
step "N sweep 1/3/5" node tests/n-sweep.test.mjs
step "N persistence (state file)" bash -c 'set -e
  node tests/state.test.mjs write
  node tests/state.test.mjs read
  PI_THINKING_PREVIEW_LINES=9 node tests/state.test.mjs read'

printf '\n%s\n' "$([ "$status" -eq 0 ] && echo 'ALL SUITES PASS' || echo 'SOME SUITES FAILED')"
exit "$status"
