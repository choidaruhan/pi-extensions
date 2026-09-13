# pi-extensions

Hand-written [pi](https://github.com/earendil-works/pi) extensions, version-controlled here and
loaded into pi through symlinks from `~/.pi/agent/extensions/`.

## What's inside

| Path | What it does |
| --- | --- |
| `extensions/thinking-preview.ts` | Gives `Thinking…` blocks three display levels and cycles them with **Ctrl+T**: `full` (whole block), `preview` (the *tail* of the block — a `... (X earlier lines, ctrl+t to cycle)` hint row plus the most recent reasoning, with the hint sitting **above N rendered rows of reasoning**, separated from the tail by one blank row — rows counted by pi's own markdown renderer, at the width pi draws at, with the extension's own row model as a fallback — and never charged to the budget, so a long line that the terminal wraps counts as the several rows it fills and blank separators are dropped rather than counted), `hidden` (one muted `Thinking…` line). Command `/thinking-preview [n\|full\|preview\|hidden]`, flag `--thinking-preview <value>`, env `PI_THINKING_PREVIEW_VIEW` / `PI_THINKING_PREVIEW_LINES`, overrides `PI_THINKING_PREVIEW_HINT` and `PI_THINKING_HIDDEN_LABEL`. The level is persisted to `~/.pi/agent/thinking-preview.json`, so `/reload` and new sessions keep it. |
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

Key handling needs one extra step, because no headless suite can prove that a
keypress reaches this extension instead of pi's built-in handler:

```bash
PI_OFFLINE=1 tools/pty-keys.py 14 6 2 -- pi --no-approve --no-extensions \
    -e ./extensions/thinking-preview.ts      # presses Ctrl+T in a real pty
```

## Tests

`./run-tests.sh` runs six suites with plain `node` (Node ≥ 23 strips TypeScript natively):

- `tests/truncate-thinking.test.mjs` — tail selection, hint formatting, the three levels, level-spec parsing and the cycle order
- `tests/render.test.mjs` — renders pi's real `AssistantMessageComponent` through the extension's own transformer, per level, and asserts the rendered block is exactly N reasoning rows plus the hint row and its blank row across five block shapes, four widths and N = 1–12
- `tests/n-sweep.test.mjs` — N = 1/3/5, level changes on a live component, and pi's own hidden-thinking path
- `tests/ctrl-t.test.mjs` — the extension's real `session_start` handler, the real `matchesKey`, Ctrl+T consumption, `/thinking-preview`, and handler stacking across sessions
- `tests/state.test.mjs` — level persistence, precedence (flag > env > saved file > default), and legacy state files
- `tests/rows.test.mjs` — row accounting checked against pi's real markdown renderer: whole-block counts for prose, CJK, lists, quotes and fences, that the shipped counter *is* that renderer (and that the fallback model still matches it on plain shapes), that shapes the fallback gets wrong (inline emphasis pi renders literally, a first line indented 4+ columns, a wide table cell) are exact, that a composed preview renders exactly N reasoning rows plus its hint row and blank row for indented continuation lines at the wrap boundary, that the composed preview never exceeds N reasoning rows (the reported bug: one long line previewed as one row)

`tests/pi-root.mjs` locates the installed pi package (`$PI_ROOT`, then Homebrew Cellar, then npm `-g`)
so the suites survive pi version bumps, and links pi's bundled `@earendil-works/pi-tui` into
`node_modules/` so the extension's bare import resolves under plain `node`.

`tools/pty-keys.py` is the heavier option: it drives pi's real TUI over a pty, sends arbitrary
keystrokes, and prints the rendered screen. Use it for anything that depends on pi's input dispatch
(Ctrl+T is the current case) — its effect is visible in `~/.pi/agent/thinking-preview.json`
and `~/.pi/agent/settings.json`.

## New machine

```bash
git clone git@github.com:choidaruhan/pi-extensions.git ~/dev/pi-extensions
~/dev/pi-extensions/install.sh      # creates the symlinks (idempotent)
./run-tests.sh
```

## Notes

- **Ctrl+T is intercepted, not registered.** `ctrl+t` is pi's reserved `app.thinking.toggle`, so an
extension cannot claim it with `pi.registerShortcut`. Instead the extension listens on
`ctx.ui.onTerminalInput()` and returns `{ consume: true }`, which stops pi's built-in toggle — and
with it the `hideThinkingBlock` write to `settings.json` — from ever running. Verified in a real pty
(`hideThinkingBlock` stays `false` while the footer advances `preview → hidden → full`).
- The interception is global, so Ctrl+T inside a pi dialog (model picker, session tree) still cycles
  the level behind the dialog. Nothing else about the key is affected.
- `hideThinkingBlock` is read by pi once, at session start. If a settings layer still has it `true`,
  the renderer takes a `Text()` path that never consults markdown transformers, so all of this
  silently does nothing; the extension warns at session start and `/thinking-preview` reports it.
- The `Took`/`Elapsed` footer was dropped (2026): thinking blocks are shown as they are, with no measured
  duration. Nothing in the extension counts time any more.
- The footer status line (`thinking:preview(3)`) was dropped too (2026): the current level is visible from
  `/thinking-preview` and from what the blocks look like, and nowhere else.
- `lines` and `view` are independent: hiding the blocks keeps the tail size, so going back to
  `preview` restores the N you had.
- `lines` is how many rows of **reasoning** the preview shows: `preview 5` shows five rows of reasoning, and the
  `... (X earlier lines…)` hint sits on the row above them without being charged to the budget (it costs the
  rows it really occupies when it wraps on a narrow preview), so the block is N reasoning rows plus the hint.
  A block shorter than N is shown whole, hint and all.
- The tail hangs directly under the hint, one source line break and no blank row: a blank row reads as a
  paragraph break rather than as a preview. The two are therefore one paragraph, so pi renders the tail
  against the hint — a tail line that starts with whitespace loses that indent and re-flows against the
  hint's text. Measured over 1,166 real thinking blocks × 3 widths × 3 budgets, the composition minus the
  hint's rows equalled the tail's own rows in 99.87% of 10,022 previews (one row either way in the rest),
  which is why the budget is charged the composition: whatever pi does with the pair is what gets counted.
- Blank separator lines never enter the tail: they are dropped rather than charged, so every one of the N
  rows is a row of reasoning instead of spacing, and even a one-row budget still shows a row of reasoning
  under its hint.
- Within that budget `lines` counts **rendered rows**, not source lines, and the count comes from pi's
  own markdown renderer — `Markdown` from `@earendil-works/pi-tui`, measured at the content width pi
  draws that block at, so emphasis, tables, indented code blocks and fences count exactly as pi draws
  them. A preview whose budget lands in the middle of such a line shows the *tail* of that line,
  re-emitted one source line per row so it wraps at the same width, and fence markers are dropped with
  the tail, so the preview can never end on a dangling fence. A lazy continuation line keeps the
  whitespace it carries (pi wraps it at the paragraph's reduced width), so its indent is counted with
  the text rather than trimmed off.
- If that renderer cannot be built (a pi release that moves or reshapes it), the preview falls back to
  its own row model and `/thinking-preview` says which counter is in use (`pi 렌더러` / `자체 행 모델(폴백)`,
  switching on the next measurement): prose, CJK, list and quote prefixes and fences still count exactly,
  while a table cell pi renders across rows, a block whose *first* line is indented 4+ columns, and inline
  emphasis pi renders literally (`${_comps[${f#_}]}`) can each be a row off near a wrap boundary.
- The count is deliberately **unstyled**: pi draws a thinking block through a colour callback, and under
  that style pi's own wrapping inserts one extra row when it breaks a token too long for the line. Counting
  the plain render keeps one code path for every block at the cost of that rare row — measured at one
  preview in ~12,000 over 1,362 real thinking blocks × widths 70/76/82.
- The fidelity that matters is one-way: **the composed preview is never taller than N reasoning rows**.
  Over those 12,137 measured previews it hit N exactly 98.62% of the time, came in a row short on 1.2%
  (a line the tail cannot split evenly) and two rows short on 0.17%; the only over-budget case was the
  styled long-token wrap above, which belongs to pi's renderer rather than to the row count.
- When even the block's last line renders taller than the budget (CJK costs two columns per character,
  pi reads a deeply indented first line as a code block, a table cell wider than its column is drawn
  across rows), the preview keeps the rows of pi's own render of that line rather than trimming it away:
  an empty thinking block would be worse than a short one. `tests/rows.test.mjs` asserts the budget is
  still met exactly on those shapes.
- pi runs registered markdown transformers over **every** assistant markdown part, the final answer text
  included. `createThinkingTransformer`'s thinking gate (`messageType`/`kind`) is what keeps previews out of
  the response body — `tests/render.test.mjs` and `tests/ctrl-t.test.mjs` assert exactly that.
- No `package.json`: these are plain auto-discovered extensions, not an npm/pi package. If you later
  want `pi install git:...` or npm publishing, add a `package.json` with a `pi` manifest — but pick
  either the package route **or** the symlinks, not both, or pi loads each extension twice.
- `AGENT_DIR` for the state file is derived from `$HOME` (or `$PI_CODING_AGENT_DIR`), so tests redirect
  `$HOME` to keep the real config untouched.
