import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	estimateTokens,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLD = 78;
/**
 * Legal threshold window: [MIN_THRESHOLD, MAX_THRESHOLD). The lower bound keeps
 * preflight meaningful: Pi's compaction keeps ~`keepRecentTokens` (20000 by
 * default) and summarizes only what exceeds it, so very low thresholds just
 * loop "Nothing to compact" soft failures and burn a summarization round trip
 * per prompt. The upper bound excludes 99: compaction itself needs headroom,
 * so a 99% trigger is already too late to be useful.
 */
const MIN_THRESHOLD = 30;
const MAX_THRESHOLD = 99;
const STATUS_KEY = "pi-auto-compact";
const CONFIG_FILE = join(getAgentDir(), "pi-auto-compact.json");
/** Compaction errors meaning "the context is already as small as it can get" — safe to send the prompt anyway. */
const SOFT_COMPACT_ERRORS = ["Nothing to compact", "Already compacted"];

function parseThreshold(raw: unknown, fallback: number): number {
	const threshold = (raw as { threshold?: unknown } | null)?.threshold;
	if (
		typeof threshold === "number" &&
		Number.isFinite(threshold) &&
		threshold >= MIN_THRESHOLD &&
		threshold < MAX_THRESHOLD
	) {
		return threshold;
	}
	return fallback;
}

/** Read the threshold from disk, keeping the last-known value when missing/invalid (hot reload). */
function loadThreshold(fallback: number = DEFAULT_THRESHOLD): number {
	try {
		return parseThreshold(JSON.parse(readFileSync(CONFIG_FILE, "utf8")), fallback);
	} catch {
		// Use the fallback when no valid config exists.
		return fallback;
	}
}

function saveThreshold(threshold: number): void {
	// Merge into the existing file so unknown keys survive, then write to a temp
	// file and rename, so a crash can never leave a half-written config.
	mkdirSync(getAgentDir(), { recursive: true });
	let existing: Record<string, unknown> = {};
	try {
		const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
		if (raw && typeof raw === "object") existing = raw as Record<string, unknown>;
	} catch {
		// Start from a clean object when the current file is missing or corrupt.
	}
	const tempFile = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempFile, `${JSON.stringify({ ...existing, threshold }, null, 2)}\n`, "utf8");
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

type StatusKind = "info" | "warning" | "error";

function setStatus(ctx: ExtensionContext, text: string | undefined, kind: StatusKind = "info"): void {
	if (!ctx.hasUI) return;
	try {
		if (text === undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
		else ctx.ui.setStatus(STATUS_KEY, kind === "info" ? text : ctx.ui.theme.fg(kind, text));
	} catch {
		// The ctx may be stale after a session switch/reload; never break the prompt flow over status updates.
	}
}

/** Context usage worth acting on, or undefined when tokens are unknown (e.g. right after compaction). */
function getValidUsage(ctx: ExtensionContext): { tokens: number; contextWindow: number } | undefined {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens == null || usage.contextWindow <= 0) return undefined;
	return { tokens: usage.tokens, contextWindow: usage.contextWindow };
}

/** Fire-and-forget notify that survives a stale ctx. */
function notifySafe(ctx: ExtensionContext, text: string, kind: StatusKind): void {
	try {
		ctx.ui.notify(text, kind);
	} catch {
		// Ignore UI failures.
	}
}

function isSoftCompactionError(error: Error): boolean {
	return SOFT_COMPACT_ERRORS.some((message) => error.message.includes(message));
}

export default function (pi: ExtensionAPI) {
	/** Last-known valid threshold; re-read from disk before each prompt (hot reload). */
	let threshold = loadThreshold();
	/** Bumped on session start/shutdown so async callbacks can detect a replaced session. */
	let sessionGeneration = 0;
	/** Shared in-flight preflight compaction; resolves to the failure (or null) once the compaction attempt settles. */
	let inFlight: Promise<Error | null> | null = null;

	/**
	 * Run ctx.compact() and wait for it to settle. ctx.compact() is fire-and-forget,
	 * so completion is observed through its onComplete/onError callbacks (Pi invokes
	 * exactly one). Resolves to the failure, or null on success. All UI access is
	 * guarded: if the session was replaced mid-compaction (gen mismatch) the old
	 * session's status bar is left alone.
	 */
	const compactAndWait = (ctx: ExtensionContext, gen: number): Promise<Error | null> =>
		new Promise<Error | null>((resolve) => {
			try {
				ctx.compact({
					onComplete: () => {
						if (gen === sessionGeneration) setStatus(ctx, undefined);
						resolve(null);
					},
					onError: (error) => {
						if (gen === sessionGeneration && !isSoftCompactionError(error)) {
							setStatus(ctx, "compact failed", "error");
						}
						resolve(error);
					},
				});
			} catch (error) {
				resolve(error instanceof Error ? error : new Error(String(error)));
			}
		});

	pi.on("session_start", (_event, ctx) => {
		sessionGeneration++;
		setStatus(ctx, undefined);
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
	});

	pi.registerCommand("compact-threshold", {
		description: `Show or set auto-compaction threshold (usage: /compact-threshold [${MIN_THRESHOLD}-${MAX_THRESHOLD - 1}])`,
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify(`Auto-compaction threshold: ${loadThreshold(threshold)}%`, "info");
				return;
			}

			if (input.toLowerCase() === "reset") {
				try {
					rmSync(CONFIG_FILE, { force: true });
					threshold = DEFAULT_THRESHOLD;
					ctx.ui.notify(`Auto-compaction threshold reset to ${threshold}%`, "info");
				} catch {
					ctx.ui.notify("Could not reset auto-compaction threshold", "error");
				}
				return;
			}

			const value = Number(input.replace(/%$/, ""));
			if (!Number.isFinite(value) || value < MIN_THRESHOLD || value >= MAX_THRESHOLD) {
				ctx.ui.notify(`Usage: /compact-threshold [${MIN_THRESHOLD}-${MAX_THRESHOLD - 1}] or /compact-threshold reset`, "warning");
				return;
			}

			try {
				// Persist first, then update memory, so a failed save never desyncs the two.
				saveThreshold(value);
				threshold = value;
				ctx.ui.notify(`Auto-compaction threshold set to ${threshold}%`, "info");
			} catch {
				ctx.ui.notify("Could not save auto-compaction threshold", "error");
			}
		},
	});

	// Status-only: show when the context is already past the threshold and the next
	// prompt will trigger a preflight compaction. No compaction happens here.
	pi.on("turn_end", (_event, ctx) => {
		threshold = loadThreshold(threshold);
		const usage = getValidUsage(ctx);
		if (!usage) {
			setStatus(ctx, undefined);
			return;
		}
		const percent = (usage.tokens / usage.contextWindow) * 100;
		if (percent >= threshold) {
			// Pi's own status bar already shows usage/window; only add the actionable hint.
			setStatus(ctx, "compact before next prompt", "warning");
		} else {
			setStatus(ctx, undefined);
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

		// Re-read per prompt so /compact-threshold changes from other sessions apply here.
		threshold = loadThreshold(threshold);
		const usage = getValidUsage(ctx);
		if (!usage) return { action: "continue" };

		const content =
			event.images && event.images.length > 0
				? [{ type: "text" as const, text: event.text }, ...event.images]
				: event.text;
		const projected = usage.tokens + estimateTokens({ role: "user", content, timestamp: Date.now() });
		if (projected < usage.contextWindow * (threshold / 100)) return { action: "continue" };

		const gen = sessionGeneration;
		const projectedPercent = ((projected / usage.contextWindow) * 100).toFixed(1);
		setStatus(ctx, `projected ${projectedPercent}% · compacting before send`, "warning");

		// Serialize concurrent prompts that race past Pi's own compaction guard:
		// reuse the in-flight compaction instead of starting a second one.
		if (!inFlight) {
			inFlight = compactAndWait(ctx, gen);
			void inFlight.finally(() => {
				inFlight = null;
			});
		}
		const error = await inFlight;
		if (gen !== sessionGeneration) return { action: "continue" };

		if (error) {
			if (isSoftCompactionError(error)) {
				// The context is already minimal (e.g. compacted seconds ago); sending is safe.
				notifySafe(ctx, `Auto-compact skipped: ${error.message}. Sending prompt anyway.`, "warning");
			} else {
				// Fail-closed: the context state is uncertain, so the prompt is not sent
				// and the user resubmits (recall it from the editor history). Note Pi's
				// compaction mutex stays locked while ctx.compact() is genuinely still
				// running, so a resubmit queues until the background compaction settles.
				notifySafe(ctx, `Auto-compact failed: ${error.message}. Prompt not sent — resubmit when ready.`, "error");
				return { action: "handled" };
			}
		}
		return { action: "continue" };
	});
}
