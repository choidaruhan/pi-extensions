# pi-extensions

Hand-written [pi](https://github.com/earendil-works/pi) extensions, version-controlled here and
loaded into pi through symlinks from `~/.pi/agent/extensions/`.

## What's inside

| Path | What it does |
| --- | --- |
| `extensions/thinking-preview.ts` | Gives `Thinking…` blocks three display levels and cycles them with **Ctrl+T**: `full` (whole block), `preview` (the *tail* of the block — N **rendered rows** of the most recent reasoning, so a long line that the terminal wraps counts as the several rows it fills — with a `... (X earlier lines, ctrl+t to cycle)` hint above), `hidden` (one muted `Thinking…` line). All levels that show text get pi's own tool-style `Took <duration>` (`Elapsed` while streaming) footer. Command `/thinking-preview [n\|full\|preview\|hidden]`, flag `--thinking-preview <value>`, env `PI_THINKING_PREVIEW_VIEW` / `PI_THINKING_PREVIEW_LINES`, overrides `PI_THINKING_PREVIEW_HINT` and `PI_THINKING_HIDDEN_LABEL`. The level is persisted to `~/.pi/agent/thinking-preview.json`, so `/reload` and new sessions keep it. |
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

- `tests/truncate-thinking.test.mjs` — tail selection, hint/footer formatting, the three levels, `Took`/`Elapsed` labels, the duration tracker, level-spec parsing and the cycle order
- `tests/render.test.mjs` — renders pi's real `AssistantMessageComponent` through the extension's own transformer, per level
- `tests/n-sweep.test.mjs` — N = 1/3/5, level changes on a live component, and pi's own hidden-thinking path
- `tests/ctrl-t.test.mjs` — the extension's real `session_start` handler, the real `matchesKey`, Ctrl+T consumption, `/thinking-preview`, and handler stacking across sessions
- `tests/state.test.mjs` — level persistence, precedence (flag > env > saved file > default), and legacy state files
- `tests/rows.test.mjs` — row accounting checked against pi's real markdown renderer: whole-block counts for prose, CJK, lists, quotes and fences, plus the preview budget never exceeding N rendered rows (the reported bug: one long line previewed as one row)

`tests/pi-root.mjs` locates the installed pi package (`$PI_ROOT`, then Homebrew Cellar, then npm `-g`)
so the suites survive pi version bumps, and links pi's bundled `@earendil-works/pi-tui` into
`node_modules/` so the extension's bare import resolves under plain `node`.

`tools/pty-keys.py` is the heavier option: it drives pi's real TUI over a pty, sends arbitrary
keystrokes, and prints the rendered screen. Use it for anything that depends on pi's input dispatch
(Ctrl+T is the current case) — its effect is visible in the footer status line, in
`~/.pi/agent/thinking-preview.json`, and in `~/.pi/agent/settings.json`.

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
- The `Took`/`Elapsed` footer measures the gap between this extension's first render of a block and its
  first non-streaming render, so it approximates the time that block spent thinking. Blocks restored
  from an older session were never observed live (and a transcript redraw must not restart the clock),
  so they show no footer. It appears on both the `full` and `preview` levels.
- `lines` and `view` are independent: hiding the blocks keeps the tail size, so going back to
  `preview` restores the N you had.
- `lines` counts **rendered rows**, not source lines: a line longer than the content width is counted as
  the several rows it wraps to, and a preview whose budget lands in the middle of such a line shows the
  *tail* of that line (with its list marker or quote border re-emitted, so the fragment wraps at the same
  width). Blank separator lines are free — N stays N lines of reasoning. Two shapes are known to be
  counted slightly off (the preview only ever errs by showing rows fewer than N, never more): pi renders
  a table cell across multiple rows, and a lazy-continued blockquote line (`> a` then `> > b`) costs one
  row more than the model predicts.
- pi runs registered markdown transformers over **every** assistant markdown part, the final answer text
  included. `createThinkingTransformer`'s thinking gate (`messageType`/`kind`) is what keeps previews and
  footers out of the response body — `tests/render.test.mjs` and `tests/ctrl-t.test.mjs` assert exactly that.
- No `package.json`: these are plain auto-discovered extensions, not an npm/pi package. If you later
  want `pi install git:...` or npm publishing, add a `package.json` with a `pi` manifest — but pick
  either the package route **or** the symlinks, not both, or pi loads each extension twice.
- `AGENT_DIR` for the state file is derived from `$HOME` (or `$PI_CODING_AGENT_DIR`), so tests redirect
  `$HOME` to keep the real config untouched.
