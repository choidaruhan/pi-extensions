# pi-extensions

Hand-written [pi](https://github.com/earendil-works/pi) extensions, version-controlled here and
loaded into pi through symlinks from `~/.pi/agent/extensions/`.

## What's inside

| Path | What it does |
| --- | --- |
| `extensions/thinking-preview.ts` | Shows the **first 5 lines** of every `Thinking…` block, then `... N more lines hidden`. No keys, no commands, no state — pi's own Ctrl+T still folds blocks away. |
| `extensions/web-search-summary-model.ts` | Keeps `web-search.json` → `summaryModel` pointed at the active pi model. Opt-in: does nothing unless that file has `"summaryModelAuto": true`. |

Not in this repo: `~/.pi/agent/extensions/herdr-agent-state.ts`, which the `herdr` tool installs and
overwrites — never edit it.

`main` keeps the older, row-accurate version of `thinking-preview.ts` (markdown-rendered rows, a
3-level Ctrl+T cycle, a persisted level file). The branch `simple-thinking-preview` (this one) is the
minimal rewrite: the whole transformation is a `split("\n")` and a slice.

## How pi loads these

pi auto-discovers `~/.pi/agent/extensions/*.ts` (and `*/index.ts`) for the global scope, so this repo
is linked in rather than copied:

```
~/.pi/agent/extensions/thinking-preview.ts -> ~/dev/pi-extensions/extensions/thinking-preview.ts
~/.pi/agent/extensions/web-search-summary-model.ts -> ~/dev/pi-extensions/extensions/web-search-summary-model.ts
```

Symlinked files and symlinked `*/index.ts` directories both work (verified on pi 0.85.1), and
`/reload` hot-reloads them exactly like real files. Because the symlink points into this repo,
**checking out a branch switches the implementation**: `git checkout main` + `/reload` restores the
old one.

## Daily loop

```bash
vim ~/dev/pi-extensions/extensions/thinking-preview.ts
~/dev/pi-extensions/run-tests.sh          # headless: no TUI, no model calls
cd ~/dev/pi-extensions && git commit -am "..."
# inside pi: /reload
```

Rendering needs one extra step, because no headless suite proves what the **TUI** draws. Render a
fabricated session — no model call, no tokens:

```bash
d=$(node tools/make-pty-fixture.mjs)      # a 25-line thinking block + a short answer
PI_OFFLINE=1 tools/pty-keys.py "" 8 4 -- pi --session "$d" -e ./extensions/thinking-preview.ts
```

The screen must show 5 reasoning lines, the `... 20 more lines hidden` hint, and the answer text.

## Tests

`./run-tests.sh` runs one suite with plain `node` (Node ≥ 23 strips TypeScript natively):

- `tests/thinking-preview.test.mjs` — `previewThinking` (head size, exact hint wording and count,
  blank separators, block that fits, custom budget) and the thinking gate, the registration wiring
  through a fake `pi`, and a render through pi's real `AssistantMessageComponent` with the same
  arguments interactive mode passes.

`tests/pi-root.mjs` locates the installed pi package (`$PI_ROOT`, then Homebrew Cellar, then npm `-g`)
so the suite survives pi version bumps, and links pi's bundled `@earendil-works/pi-tui` into
`node_modules/` so the extension's bare import resolves under plain `node`.

`tools/pty-keys.py` is the heavier option: it drives pi's real TUI over a pty, sends arbitrary
keystrokes (`""` for none), and prints the rendered screen.

## New machine

```bash
git clone git@github.com:choidaruhan/pi-extensions.git ~/dev/pi-extensions
~/dev/pi-extensions/install.sh      # creates the symlinks (idempotent)
./run-tests.sh
```

## Notes

- **The budget is lines of reasoning, not rendered rows.** Five reasoning lines can occupy more than
  five terminal rows when a line wraps. That is the deliberate trade for a transformer that does no
  markdown parsing, no width measurement and no row counting — cheap enough to re-run on every
  streaming update.
- **The visible part is a fixed head**, so it never moves while the model is still thinking: no
  scroll jitter, and no re-measure per delta.
- Blank separator lines are neither spent from the budget nor counted as hidden, so the hint's count
  is exact; blanks inside the head are kept, so paragraphs and lists keep their shape. A block that
  fits within the budget is returned untouched.
- `hideThinkingBlock` is read by pi once, at session start. If any settings layer has it `true`, the
  renderer takes a `Text()` path that never consults markdown transformers and the preview silently
  does nothing (`~/.pi/agent/settings.json` currently has it `false`).
- pi runs registered markdown transformers over **every** assistant markdown part, the final answer
  text included. The thinking gate (`messageType === "assistant-thinking"`, `kind === "thinking"` on
  older builds) is what keeps previews out of the response body — the suite asserts exactly that.
- Only one transformer per extension: `registerMarkdownTransformer` stores it in a single
  `extension.markdownTransformer` slot, so registering twice replaces the first.
- No `package.json`: these are plain auto-discovered extensions, not an npm/pi package. If you later
  want `pi install git:...` or npm publishing, add a `package.json` with a `pi` manifest — but pick
  either the package route **or** the symlinks, not both, or pi loads each extension twice.
