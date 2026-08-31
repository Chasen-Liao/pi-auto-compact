# pi-auto-compact

A minimal Pi extension that compacts the conversation **before sending a prompt** when the projected context (current usage plus the new input) crosses a configurable percentage of the current model's context window.

Compaction itself always reuses Pi's built-in `ctx.compact()` implementation. Pi's own automatic compaction is untouched — if enabled in Pi's settings, it still acts as the final safety net.

## Install

```bash
pi install npm:pi-auto-compact
```

Or install directly from GitHub:

```bash
pi install git:github.com/Chasen-Liao/pi-auto-compact
```

## Configuration

The default threshold is **78% used**. Change it inside Pi with:

```text
/compact-threshold 50
```

Values are **30–98** (decimals allowed). The lower bound keeps preflight meaningful: Pi's compaction keeps roughly `keepRecentTokens` (20000 by default) of recent history and only summarizes beyond it, so thresholds below ~10–15% of the window would mostly hit "Nothing to compact" no-ops. Setting the value saves the config atomically. Show the current value:

```text
/compact-threshold
```

Reset to the default 78%:

```text
/compact-threshold reset
```

The threshold is calculated against the active model's context window, so the same percentage works across models with different window sizes.

## Behavior

- **Preflight trigger**: when you submit a prompt while the agent is idle, the extension estimates `current context + your input` (using Pi's own token estimator). At or above the threshold, it compacts once before the prompt is sent, so long inputs never interrupt a running tool chain.
- **Failure policy**: preflight distinguishes three outcomes. *Soft* errors (`Nothing to compact` / `Already compacted`), *aborted* compactions (Ctrl+C / session teardown), and a *stall timeout* (see below) all mean the context is safe to send, so the prompt goes through and a warning is shown. Any other compaction failure is *hard*: the prompt is **not sent**, and its text is restored into the editor so you never lose input (unless you already started typing something new).
- **Stall timeout**: Pi's `ctx.compact()` has no cancel handle and can, in rare cases, never invoke its completion/error callbacks (e.g. a stalled summarization request). The extension stops waiting after a timeout (default **90s**) so a stuck compaction can never deadlock the prompt flow, treating it as the safe "send anyway" case.
- **Status**: the footer shows a warning when context is past the threshold (next prompt will compact) and while preflight compaction is running.
- **Not preflighted**: messages queued during an active run (steer/followUp), slash commands handled before the input event, and content injected later by `/skill:` or `/template` expansion — those remain covered by Pi's built-in compaction.
- **Requires a known context window**: if the active model doesn't report one (or usage is unknown, e.g. right after a compaction), the preflight is skipped and Pi's built-in compaction covers it.
- Session switches/reloads mid-compaction are detected; stale callbacks never touch the new session's status.

## Advanced

The threshold is re-read from the config file on every preflight, so changes made by another Pi session take effect without a reload. An optional `compactTimeoutMs` key (1000–600000) in the same file tunes the stall timeout; it is preserved across `/compact-threshold` writes.

## Development

```bash
npm install
npm run typecheck
npm test        # mock smoke tests (Node native TS, no agent state touched)
pi -e .
```

## License

MIT
