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

step "truncateThinking unit + level specs" node tests/truncate-thinking.test.mjs
step "TUI render (real component)" node tests/render.test.mjs
step "level/N sweep" node tests/n-sweep.test.mjs
step "Ctrl+T wiring (real matchesKey)" node tests/ctrl-t.test.mjs
step "state persistence" bash -c 'set -e
  node tests/state.test.mjs write
  node tests/state.test.mjs read
  PI_THINKING_PREVIEW_VIEW=full node tests/state.test.mjs env
  PI_THINKING_PREVIEW_LINES=2 node tests/state.test.mjs env'

printf '\n%s\n' "$([ "$status" -eq 0 ] && echo 'ALL SUITES PASS' || echo 'SOME SUITES FAILED')"
exit "$status"