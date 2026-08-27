import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	estimateTokens,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLD = 78;
const STATUS_KEY = "pi-auto-compact";
const CONFIG_FILE = join(getAgentDir(), "pi-auto-compact.json");
/** Compaction errors meaning "the context is already as small as it can get" — safe to send the prompt anyway. */
const SOFT_COMPACT_ERRORS = ["Nothing to compact", "Already compacted"];

function loadThreshold(): number {
	try {
		const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { threshold?: unknown };
		if (
			typeof config.threshold === "number" &&
			Number.isFinite(config.threshold) &&
			config.threshold > 0 &&
			config.threshold < 100
		) {
			return config.threshold;
		}
	} catch {
		// Use the default when no valid config exists.
	}
	return DEFAULT_THRESHOLD;
}

function saveThreshold(threshold: number): void {
	// Write to a temp file first and rename, so a crash can never leave a half-written config.
	mkdirSync(getAgentDir(), { recursive: true });
	const tempFile = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempFile, `${JSON.stringify({ threshold }, null, 2)}\n`, "utf8");
	try {
		renameSync(tempFile, CONFIG_FILE);
	} catch (error) {
		try {
			rmSync(tempFile, { force: true });
		} catch {
			// Best-effort cleanup; the rename error matters more.
		}
		throw error;
	}
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens)}`;
}

type StatusKind = "info" | "warning" | "error";

function setStatus(ctx: ExtensionContext, text: string, kind: StatusKind): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setStatus(STATUS_KEY, kind === "info" ? text : ctx.ui.theme.fg(kind, text));
	} catch {
		// The ctx may be stale after a session switch/reload; never break the prompt flow over status updates.
	}
}

function clearStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	} catch {
		// Same as setStatus: a stale ctx must not break anything.
	}
}

function isSoftCompactionError(error: Error): boolean {
	return SOFT_COMPACT_ERRORS.some((message) => error.message.includes(message));
}

export default function (pi: ExtensionAPI) {
	let threshold = loadThreshold();
	/** Bumped on session start/shutdown so async callbacks can detect a replaced session. */
	let generation = 0;
	/** Shared in-flight preflight compaction; resolves once the compaction attempt settles. */
	let inFlight: Promise<CompactionOutcome> | null = null;

	interface CompactionOutcome {
		/** Whether compaction completed. */
		ok: boolean;
		/** The failure, when ok is false. */
		error: Error | null;
	}

	/**
	 * Run ctx.compact() and wait for it to settle. ctx.compact() is fire-and-forget,
	 * so completion is observed through its onComplete/onError callbacks. All UI access
	 * is guarded: if the session was replaced mid-compaction (gen mismatch) the old
	 * session's status bar is left alone.
	 */
	const compactAndWait = (ctx: ExtensionContext, gen: number): Promise<CompactionOutcome> =>
		new Promise<CompactionOutcome>((resolve) => {
			let settled = false;
			const finish = (outcome: CompactionOutcome) => {
				if (settled) return;
				settled = true;
				resolve(outcome);
			};
			try {
				ctx.compact({
					onComplete: () => {
						if (gen === generation) clearStatus(ctx);
						finish({ ok: true, error: null });
					},
					onError: (error) => {
						if (gen === generation) setStatus(ctx, "compact failed", "error");
						finish({ ok: false, error });
					},
				});
			} catch (error) {
				finish({ ok: false, error: error instanceof Error ? error : new Error(String(error)) });
			}
		});

	pi.on("session_start", (_event, ctx) => {
		generation++;
		clearStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		generation++;
	});

	// Status-only: show when the context is already past the threshold and the next
	// prompt will trigger a preflight compaction. No compaction happens here.
	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null || usage.contextWindow <= 0) {
			clearStatus(ctx);
			return;
		}
		const percent = (usage.tokens / usage.contextWindow) * 100;
		if (percent >= threshold) {
			setStatus(
				ctx,
				`${percent.toFixed(1)}%/${formatTokens(usage.contextWindow)} · compact before next prompt`,
				"warning",
			);
		} else {
			clearStatus(ctx);
		}
	});

	// Preflight: when the agent is idle and the projected context (current usage plus
	// the new prompt) crosses the threshold, compact once before the prompt is sent.
	// The prompt itself keeps flowing through Pi's normal path (no re-injection), and
	// Pi's built-in auto-compaction stays enabled as the final safety net.
	pi.on("input", async (event, ctx) => {
		// Messages queued during an active run (steer/followUp) cannot be preflighted:
		// ctx.compact() would abort the running agent.
		if (event.streamingBehavior !== undefined) return { action: "continue" };

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null || usage.contextWindow <= 0) return { action: "continue" };

		const content =
			event.images && event.images.length > 0
				? [{ type: "text" as const, text: event.text }, ...event.images]
				: event.text;
		const projected = usage.tokens + estimateTokens({ role: "user", content, timestamp: Date.now() });
		if (projected < usage.contextWindow * (threshold / 100)) return { action: "continue" };

		const gen = generation;
		const projectedPercent = ((projected / usage.contextWindow) * 100).toFixed(1);
		setStatus(ctx, `projected ${projectedPercent}% · compacting before send`, "warning");

		// Serialize concurrent prompts that race past Pi's own compaction guard:
		// reuse the in-flight compaction instead of starting a second one.
		if (!inFlight) {
			const current = compactAndWait(ctx, gen);
			inFlight = current;
			void current.finally(() => {
				if (inFlight === current) inFlight = null;
			});
		}
		const outcome = await inFlight;
		if (gen !== generation) return { action: "continue" };

		if (outcome.error) {
			if (isSoftCompactionError(outcome.error)) {
				// The context is already minimal (e.g. compacted seconds ago); sending is safe.
				try {
					ctx.ui.notify(`Auto-compact skipped: ${outcome.error.message}. Sending prompt anyway.`, "warning");
				} catch {
					// Ignore UI failures.
				}
			} else {
				try {
					ctx.ui.notify(
						`Auto-compact failed: ${outcome.error.message}. Prompt not sent — resubmit when ready.`,
						"error",
					);
				} catch {
					// Ignore UI failures.
				}
				return { action: "handled" };
			}
		}
		return { action: "continue" };
	});
}
