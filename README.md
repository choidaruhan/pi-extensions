# pi-extensions

Hand-written [pi](https://github.com/earendil-works/pi) extensions, version-controlled here and
loaded into pi through symlinks from `~/.pi/agent/extensions/`.

## What's inside

| Path | What it does |
| --- | --- |
| `extensions/thinking-preview.ts` | Gives `Thinking…` blocks three display levels, cycled with **Ctrl+T**: `full` (whole block), `preview` (the last N lines of reasoning under a `... (X earlier lines, ctrl+t to cycle)` hint — the default), `hidden` (one muted `Thinking…` line). Command `/thinking-preview [n\|full\|preview\|hidden]`, flag `--thinking-preview <value>`, env `PI_THINKING_PREVIEW_VIEW` / `PI_THINKING_PREVIEW_LINES`, overrides `PI_THINKING_PREVIEW_HINT` / `PI_THINKING_HIDDEN_LABEL`. The level is persisted to `~/.pi/agent/thinking-preview.json`, so `/reload` and new sessions keep it. |
| `extensions/web-search-summary-model.ts` | Keeps `web-search.json` → `summaryModel` pointed at the active pi model. Opt-in: does nothing unless that file has `"summaryModelAuto": true`. |

Not in this repo: `~/.pi/agent/extensions/herdr-agent-state.ts`, which the `herdr` tool installs and
overwrites — never edit it.

The branch `simple-thinking-preview` (this one) is a rewrite of `thinking-preview.ts` that drops the
row-model machinery: the transformer is pure string work instead of rendering the block through pi's
markdown renderer on every streaming update. `main` keeps the older, row-accurate version.

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

Key handling needs one extra step, because no headless suite can prove that a
keypress reaches this extension instead of pi's built-in handler:

```bash
PI_OFFLINE=1 tools/pty-keys.py 14 6 2 -- pi --no-approve --no-extensions \
    -e ./extensions/thinking-preview.ts      # presses Ctrl+T in a real pty
```

## Tests

`./run-tests.sh` runs one suite with plain `node` (Node ≥ 23 strips TypeScript natively):

- `tests/thinking-preview.test.mjs` — `truncateThinking` (tail, hint wording/count, blank
  separators, budget edge cases), level-spec parsing and the cycle order, state persistence and
  env precedence, event wiring through a fake `pi`/`ui` with the real `matchesKey` (Ctrl+T consumed,
  neighbouring keys not, command behaviour, handler stacking across sessions), and a render through
  pi's real `AssistantMessageComponent` per level.

`tests/pi-root.mjs` locates the installed pi package (`$PI_ROOT`, then Homebrew Cellar, then npm `-g`)
so the suite survives pi version bumps, and links pi's bundled `@earendil-works/pi-tui` into
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

- **The budget is lines of reasoning, not rendered rows.** `preview 5` shows the last five lines of
  reasoning with the hint above them; a long line the terminal wraps can therefore make the block
  taller than five rows. That is the deliberate trade for a transformer that does no markdown
  parsing, no width measurement and no row counting — the whole transformation is a `split("\n")`
  and a slice, so it is cheap enough to run on every streaming update.
- The hint's count is exact: it reports the same lines the budget counted. Blank separator lines are
  neither spent from the budget nor reported as hidden; when a blank falls inside the tail it stays,
  so paragraphs and fenced blocks keep their shape. A block no taller than the budget is shown whole,
  hint and all.
- The tail hangs directly under the hint — one source line break, no blank row — so the two render as
  one paragraph.
- **Ctrl+T is intercepted, not registered.** `ctrl+t` is pi's reserved `app.thinking.toggle`, so an
  extension cannot claim it with `pi.registerShortcut`. Instead the extension listens on
  `ctx.ui.onTerminalInput()` and returns `{ consume: true }`, which stops pi's built-in toggle — and
  with it the `hideThinkingBlock` write to `settings.json` — from ever running. Verified in a real pty
  (`hideThinkingBlock` stays `false` while the level advances `full → preview → hidden`).
- The interception is global, so Ctrl+T inside a pi dialog (model picker, session tree) still cycles
  the level behind the dialog. Nothing else about the key is affected.
- `hideThinkingBlock` is read by pi once, at session start. If a settings layer still has it `true`,
  the renderer takes a `Text()` path that never consults markdown transformers, so all of this
  silently does nothing; the extension warns at session start and `/thinking-preview` reports it.
- Re-rendering the transcript after a level change goes through `ctx.ui.setHiddenThinkingLabel()` with
  no argument — the only redraw entry point the extension UI API exposes; pi resolves the missing label
  to its default and calls `updateContent` on every rendered message, which re-runs the transformers.
- `lines` and `view` are independent: hiding the blocks keeps the tail size, so going back to
  `preview` restores the N you had.
- pi runs registered markdown transformers over **every** assistant markdown part, the final answer
  text included. `createThinkingTransformer`'s thinking gate (`messageType`/`kind`) is what keeps
  previews out of the response body — the test suite asserts exactly that.
- No `package.json`: these are plain auto-discovered extensions, not an npm/pi package. If you later
  want `pi install git:...` or npm publishing, add a `package.json` with a `pi` manifest — but pick
  either the package route **or** the symlinks, not both, or pi loads each extension twice.
- `AGENT_DIR` for the state file is derived from `$HOME` (or `$PI_CODING_AGENT_DIR`), so tests redirect
  `$HOME` to keep the real config untouched.
