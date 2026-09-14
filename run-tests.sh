#!/usr/bin/env bash
# Headless suite for these extensions: no TUI, no model calls.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

node tests/thinking-preview.test.mjs
