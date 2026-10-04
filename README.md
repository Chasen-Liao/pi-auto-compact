# pi-auto-compact

A minimal Pi extension that compacts the conversation **before sending a prompt** when the projected context (current usage plus the new input) crosses a configurable percentage of the current model's context window, and reports context pressure **before every tool call** during a run.

Compaction itself always reuses Pi's built-in `ctx.compact()` implementation. Pi's own automatic compaction stays the safety net — including its mid-run check between tool batches — and the only thing the extension ever writes into Pi's settings is one per-model compaction budget, and only when you opt in with `/compact-threshold align on`.

Requires `@earendil-works/pi-coding-agent >= 0.99.0` on Node 22.19+ (verified against pi 1.0.2).

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

The threshold is calculated against the active model's context window, so the same percentage works across models with different window sizes. It is re-read before every prompt and turn, so config changes apply without restarting the session.

## Mid-run (between tool calls) compaction

Pi compacts **between tool batches** — after a batch of tool results is appended and before the next assistant response — whenever the context passes `contextWindow - compaction.reserveTokens`, and the run continues afterwards. That check is Pi's, not the extension's: `ctx.compact()` aborts the running turn, so an extension cannot compact mid-run and keep going.

Two things make the configured threshold visible during a run:

- **The `tool_call` check (always on)**: before every tool call the extension reads the context usage and shows what is pending — `context 80% · pi compacts at 94% between tool batches` while Pi's own threshold is still ahead, and `context 95% · compacting after this tool batch` once Pi's threshold is already crossed (Pi compacts as soon as this batch finishes, and the run continues). The check never blocks a tool and never compacts.
- **Threshold alignment (opt-in)**: `/compact-threshold align on` writes a per-model `compaction.modelOverrides["<provider>/<model>"].reserveTokens` into `~/.pi/agent/settings.json` so Pi's own checks — the mid-run one included — fire at *this* threshold instead of Pi's default (`contextWindow - 16384`, about 92% on a 200k window). Run `/reload` afterwards to make Pi pick it up. `align off` removes exactly the entries the extension wrote; a reserve you configured yourself is never touched or removed.

```text
/compact-threshold align on     # mid-run compaction follows the threshold
/reload                         # let pi re-read its settings
/compact-threshold align off    # back to pi's own threshold
```

A larger reserve also raises the token cap Pi gives the summary itself (`0.8 × reserveTokens`, still bounded by the model's max output tokens), so summaries may get longer.

## Behavior

- **Preflight trigger**: when you submit a prompt while the agent is idle, the extension estimates `current context + your input` (using Pi's own token estimator). At or above the threshold, it compacts once before the prompt is sent, so long inputs never interrupt a running tool chain.
- **Failure policy**: if preflight compaction fails, the prompt is **not sent** (fail-closed; recall it from the editor history and resubmit) and an error is shown. Exception: "Nothing to compact" / "Already compacted" mean the context is already minimal, so the prompt is sent anyway.
- **Status**: the footer shows a warning when context is past the threshold (next prompt will compact), while preflight compaction is running, and — during a run — which compaction is pending (see above).
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

`npm test` runs a mock smoke suite (`test/smoke.ts`, Node native TS type stripping) that covers threshold gating, failure classification, concurrency, session guarding, config persistence, image-prompt projection, the mid-run `tool_call` check, and threshold alignment (write, user-owned reserves, cleanup).

## License

MIT
