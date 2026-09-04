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

Values are 30–98; 99 is rejected because compaction itself needs headroom. This saves the setting atomically (merging into the existing file, so other keys survive). Show the current value:

```text
/compact-threshold
```

Reset to the default 78%:

```text
/compact-threshold reset
```

The threshold is calculated against the active model's context window, so the same percentage works across models with different window sizes.

Optional `compactTimeoutMs` (1000–600000, default 90000) caps how long one preflight compaction may take; set it by hand in `~/.pi/agent/pi-auto-compact.json`. Both values are re-read before every prompt, so config changes apply without restarting the session.

## Behavior

- **Preflight trigger**: when you submit a prompt while the agent is idle, the extension estimates `current context + your input` (using Pi's own token estimator). At or above the threshold, it compacts once before the prompt is sent, so long inputs never interrupt a running tool chain.
- **Failure policy**: if preflight compaction fails or stalls past `compactTimeoutMs`, the prompt is **not sent** (fail-closed; recall it from the editor history and resubmit) and an error is shown. Exception: "Nothing to compact" / "Already compacted" mean the context is already minimal, so the prompt is sent anyway.
- **Stall safety**: Pi's `ctx.compact()` has no cancel handle and can stall without ever invoking its callbacks (verified in SDK 0.84.3/0.84.4). The timeout guarantees the wait always settles — the timer is deliberately not `unref()`'d, since it is the only thing keeping an awaiting prompt alive in print mode. Note Pi's own compaction mutex stays locked while `ctx.compact()` is genuinely still running, so a resubmit queues until the background compaction settles.
- **Status**: the footer shows a warning when context is past the threshold (next prompt will compact) and while preflight compaction is running.
- **Not preflighted**: messages queued during an active run (steer/followUp), slash commands handled before the input event, and content injected later by `/skill:` or `/template` expansion — those remain covered by Pi's built-in compaction.
- **Requires a known context window**: if the active model doesn't report one (or usage is unknown, e.g. right after a compaction), the preflight is skipped and Pi's built-in compaction covers it.
- Session switches/reloads mid-compaction are detected; stale callbacks never touch the new session's status.

## Development

```bash
npm install
npm run typecheck
npm test
pi -e .
```

`npm test` runs a mock smoke suite (`test/smoke.ts`, Node native TS type stripping) that covers threshold gating, failure classification, timeout, concurrency, session guarding, and config persistence.

## License

MIT
