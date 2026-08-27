# pi-auto-compact

A minimal Pi extension that automatically compacts the conversation when context usage reaches a configurable percentage of the current model's context window.

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

This saves the setting globally. Show the current value:

```text
/compact-threshold
```

Reset to the default 78%:

```text
/compact-threshold reset
```

The threshold is calculated against the active model's context window, so the same percentage works across models with different window sizes.

When the threshold is reached at the end of a turn, the extension calls Pi's built-in `ctx.compact()`. While compaction is starting, the footer shows a red context status.

## Development

```bash
npm install
npm run typecheck
pi -e .
```

## License

MIT
