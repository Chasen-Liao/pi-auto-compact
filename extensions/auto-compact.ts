import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLD = 78;
const STATUS_KEY = "pi-auto-compact";
const CONFIG_FILE = join(getAgentDir(), "pi-auto-compact.json");

function loadThreshold(): number {
	try {
		const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { threshold?: unknown };
		if (typeof config.threshold === "number" && config.threshold > 0 && config.threshold < 100) {
			return config.threshold;
		}
	} catch {
		// Use the default when no valid config exists.
	}
	return DEFAULT_THRESHOLD;
}

function saveThreshold(threshold: number): void {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(CONFIG_FILE, `${JSON.stringify({ threshold }, null, 2)}\n`, "utf8");
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens)}`;
}

function updateStatus(ctx: ExtensionContext, tokens: number, contextWindow: number, threshold: number) {
	if (!ctx.hasUI) return;
	const percent = (tokens / contextWindow) * 100;
	if (percent >= threshold) {
		const text = `${percent.toFixed(1)}%/${formatTokens(contextWindow)} · compacting`;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", text));
	} else {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

export default function (pi: ExtensionAPI) {
	let threshold = loadThreshold();
	let compacting = false;

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("compact-threshold", {
		description: "Show or set auto-compaction threshold (usage: /compact-threshold [1-99])",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify(`Auto-compaction threshold: ${threshold}%`, "info");
				return;
			}

			if (input.toLowerCase() === "reset") {
				threshold = DEFAULT_THRESHOLD;
				try {
					if (existsSync(CONFIG_FILE)) unlinkSync(CONFIG_FILE);
					ctx.ui.notify(`Auto-compaction threshold reset to ${threshold}%`, "info");
				} catch {
					ctx.ui.notify("Could not reset auto-compaction threshold", "error");
				}
				return;
			}

			const value = Number(input.replace(/%$/, ""));
			if (!Number.isFinite(value) || value <= 0 || value >= 100) {
				ctx.ui.notify("Usage: /compact-threshold [1-99] or /compact-threshold reset", "warning");
				return;
			}

			threshold = value;
			try {
				saveThreshold(threshold);
				ctx.ui.notify(`Auto-compaction threshold set to ${threshold}%`, "info");
			} catch {
				ctx.ui.notify("Could not save auto-compaction threshold", "error");
			}
		},
	});

	pi.on("turn_end", (_event, ctx: ExtensionContext) => {
		if (compacting) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null || usage.contextWindow <= 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		updateStatus(ctx, usage.tokens, usage.contextWindow, threshold);
		if (usage.tokens < usage.contextWindow * (threshold / 100)) return;

		compacting = true;
		ctx.compact({
			onComplete: () => {
				compacting = false;
				ctx.ui.setStatus(STATUS_KEY, undefined);
			},
			onError: () => {
				compacting = false;
				ctx.ui.setStatus(STATUS_KEY, undefined);
			},
		});
	});
}
