# pi-extensions

Hand-written [pi](https://github.com/earendil-works/pi) extensions, version-controlled here and
loaded into pi through symlinks from `~/.pi/agent/extensions/`.

## What's inside

| Path | What it does |
| --- | --- |
| `extensions/thinking-preview.ts` | Keeps the *last* N lines of each `Thinking…` block — the most recent reasoning — with a `... (X earlier lines, ctrl+o to expand)` hint above and a `Took <duration>` (`Elapsed` while streaming) footer below, mirroring pi's own collapsed tool output. Command `/thinking-preview [n\|off]`, flag `--thinking-preview <n>`, env `PI_THINKING_PREVIEW_LINES`, hint override `PI_THINKING_PREVIEW_HINT`. N is persisted to `~/.pi/agent/thinking-preview.json` so `/reload` and new sessions keep it. |
| `extensions/web-search-summary-model.ts` | Keeps `web-search.json` → `summaryModel` pointed at the active pi model. Opt-in: does nothing unless that file has `"summaryModelAuto": true`. |

Not in this repo: `~/.pi/agent/extensions/herdr-agent-state.ts`, which the `herdr` tool installs and
overwrites — never edit it.

## How pi loads these

pi auto-discovers `~/.pi/agent/extensions/*.ts` (and `*/index.ts`) for the global scope, so this repo
is linked in rather than copied:

```
~/.pi/agent/extensions/thinking-preview.ts -> ~/dev/pi-extensions/extensions/thinking-preview.ts
~/.pi/agent/extensions/web-search-summary-model.ts -> ~/dev/pi-extensions/extensions/web-search-summary-model.ts
```

Symlinked files and symlinked `*/index.ts` directories both work (verified on pi 0.85.1), and
`/reload` hot-reloads them exactly like real files.

## Daily loop

```bash
vim ~/dev/pi-extensions/extensions/thinking-preview.ts
~/dev/pi-extensions/run-tests.sh          # headless: no TUI, no model calls
cd ~/dev/pi-extensions && git commit -am "..."
# inside pi: /reload
```

## Tests

`./run-tests.sh` runs four suites with plain `node` (Node ≥ 23 strips TypeScript natively):

- `tests/truncate-thinking.test.mjs` — tail selection, hint/footer formatting, duration tracker, transformer wiring
- `tests/render.test.mjs` — renders pi's real `AssistantMessageComponent` through the extension's own transformer
- `tests/n-sweep.test.mjs` — N = 1/3/5, mid-session N changes, and the hidden-thinking path
- `tests/state.test.mjs` — N persistence and precedence (flag > env > saved file > default)

`tests/pi-root.mjs` locates the installed pi package (`$PI_ROOT`, then Homebrew Cellar, then npm `-g`)
so the suites survive pi version bumps.

## New machine

```bash
git clone git@github.com:choidaruhan/pi-extensions.git ~/dev/pi-extensions
~/dev/pi-extensions/install.sh      # creates the symlinks (idempotent)
./run-tests.sh
```

## Notes

- The `Took`/`Elapsed` footer measures the gap between this extension's first render of a block and its
  first non-streaming render, so it approximates the time that block spent thinking. Blocks restored
  from an older session were never observed live (and a transcript redraw must not restart the clock),
  so they show no footer.
- pi runs registered markdown transformers over **every** assistant markdown part, the final answer text
  included. `createThinkingTransformer`'s `messageType` gate is what keeps the preview and the footer
  out of the response body — `tests/render.test.mjs` asserts exactly that.
- No `package.json`: these are plain auto-discovered extensions, not an npm/pi package. If you later
  want `pi install git:...` or npm publishing, add a `package.json` with a `pi` manifest — but pick
  either the package route **or** the symlinks, not both, or pi loads each extension twice.
- `AGENT_DIR` for the state file is derived from `$HOME`, so tests redirect `$HOME` to keep the real
  config untouched.
