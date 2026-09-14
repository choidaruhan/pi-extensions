# pi-extensions

Hand-written [pi](https://github.com/earendil-works/pi) extensions, version-controlled here and
loaded into pi through symlinks from `~/.pi/agent/extensions/`.

## What's inside

| Path | What it does |
| --- | --- |
| `extensions/thinking-preview.ts` | Three levels for every `Thinking…` block, cycled with **Ctrl+T**: `preview` (the **first 5 lines**, then `... N more lines hidden (ctrl+t)` — the default), `full` (the whole block), `hidden` (one `Thinking...` line). No state file, no flag, no env var, no command. |
| `extensions/web-search-summary-model.ts` | Keeps `web-search.json` → `summaryModel` pointed at the active pi model. Opt-in: does nothing unless that file has `"summaryModelAuto": true`. |

Not in this repo: `~/.pi/agent/extensions/herdr-agent-state.ts`, which the `herdr` tool installs and
overwrites — never edit it.

`main` keeps the older, row-accurate version of `thinking-preview.ts`: the same three levels, but
rendered rows instead of lines, plus a persisted level file, a `--thinking-preview` flag, an env var
and a `/thinking-preview` command. The branch `simple-thinking-preview` (this one) keeps the three
levels and drops all of that — the whole transformation is a `split("\n")` and a slice.

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

The screen must show the first 5 reasoning lines, the `... 20 more lines hidden (ctrl+t)` hint, and
the answer text. Send the key to check the cycle — `tools/pty-keys.py 14 10 3 -- ...` presses Ctrl+T
(`\x14`), and the screen must then show all 25 reasoning lines and no hint.

## Tests

`./run-tests.sh` runs one suite with plain `node` (Node ≥ 23 strips TypeScript natively):

- `tests/thinking-preview.test.mjs` — `promptThinking` per level (head size, exact hint wording and
  count, blank separators, block that fits, custom budget, `full` untouched, `hidden` label), the
  cycle order and the thinking gate, the registration wiring through a fake `pi`/`ui` with pi's real
  `matchesKey` (Ctrl+T consumed, neighbouring keys not, subscription replaced across sessions,
  shutdown), and a render per level through pi's real `AssistantMessageComponent` with the same
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
- **Ctrl+T is intercepted, not registered.** `ctrl+t` is pi's reserved `app.thinking.toggle`, so an
  extension cannot claim it with `pi.registerShortcut`. Instead the extension listens on
  `ctx.ui.onTerminalInput()` and returns `{ consume: true }`, which stops pi's built-in toggle — and
  with it the `hideThinkingBlock` write to `settings.json` — from running. Verified in a real pty: the
  screen goes from 5 reasoning lines to all 25 while `hideThinkingBlock` stays `false`.
- The level is module state, so it lives for the **run**: a new pi starts at `preview` again. The
  subscription is re-registered on every `session_start` (pi fires it again on a session switch) after
  dropping the previous one, or one keypress would advance two levels.
- Changing the level must re-render **already-rendered** blocks, since a transformer's output is baked
  in when the block first renders. `ctx.ui.setHiddenThinkingLabel()` with no argument is the only
  redraw entry point the extension UI API exposes (see docs/extensions.md); pi resolves the missing
  label to its default and calls `updateContent` on every rendered message.
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
