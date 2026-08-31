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
 * default, ≈10% of a 200k window) and summarizes only what exceeds it, so very
 * low thresholds just loop "Nothing to compact" soft failures and burn a
 * summarization round trip per prompt.
 */
const MIN_THRESHOLD = 30;
const MAX_THRESHOLD = 99;
/**
 * Safety ceiling for one preflight compaction. Pi's ctx.compact() has no cancel
 * handle, and its summarization request or internal abort step can stall without
 * ever invoking onComplete/onError — without this ceiling a stalled compaction
 * deadlocks every subsequent preflight.
 */
const DEFAULT_COMPACT_TIMEOUT_MS = 90_000;
const STATUS_KEY = "pi-auto-compact";
const CONFIG_FILE = join(getAgentDir(), "pi-auto-compact.json");
/** Compaction errors meaning "the context is already as small as it can get" — safe to send the prompt anyway. */
const SOFT_COMPACT_ERRORS = ["Nothing to compact", "Already compacted"];

interface Config {
	threshold: number;
	compactTimeoutMs: number;
}

const DEFAULT_CONFIG: Config = { threshold: DEFAULT_THRESHOLD, compactTimeoutMs: DEFAULT_COMPACT_TIMEOUT_MS };

function parseConfig(raw: unknown, fallback: Config): Config {
	const config = raw as { threshold?: unknown; compactTimeoutMs?: unknown } | null;
	let { threshold, compactTimeoutMs } = fallback;
	if (
		typeof config?.threshold === "number" &&
		Number.isFinite(config.threshold) &&
		config.threshold >= MIN_THRESHOLD &&
		config.threshold < MAX_THRESHOLD
	) {
		threshold = config.threshold;
	}
	if (
		typeof config?.compactTimeoutMs === "number" &&
		Number.isFinite(config.compactTimeoutMs) &&
		config.compactTimeoutMs >= 1000 &&
		config.compactTimeoutMs <= 600_000
	) {
		compactTimeoutMs = config.compactTimeoutMs;
	}
	return { threshold, compactTimeoutMs };
}

/** Read the config file, keeping the last-known values for any missing/invalid field. */
function loadConfig(fallback: Config = DEFAULT_CONFIG): Config {
	try {
		return parseConfig(JSON.parse(readFileSync(CONFIG_FILE, "utf8")), fallback);
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

/**
 * Pi aborts an in-flight compaction on Ctrl+C and session teardown by throwing
 * an AbortError / "Compaction cancelled" — the user already opted out of the
 * compaction, so fail open and let the prompt through instead of swallowing it.
 */
function isAbortError(error: Error): boolean {
	return error.name === "AbortError" || /cancel|\baborted?\b/i.test(error.message);
}

/**
 * Put the rejected prompt back into the editor so a hard compaction failure
 * never loses user input. Skipped when the editor already holds new text.
 */
function restorePromptText(ctx: ExtensionContext, text: string): boolean {
	if (!ctx.hasUI || !text) return false;
	try {
		if (ctx.ui.getEditorText()) return false;
		ctx.ui.setEditorText(text);
		return true;
	} catch {
		// Editor access is TUI-only; never break the failure path over it.
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	/** Bumped on session start/shutdown so async callbacks can detect a replaced session. */
	let sessionGeneration = 0;
	/** Bumped per compactAndWait() call so only the newest compaction may touch the status line. */
	let compactSequence = 0;
	/** Shared in-flight preflight compaction; resolves once the compaction attempt settles. */
	let inFlight: Promise<CompactionOutcome> | null = null;

	interface CompactionOutcome {
		/** Whether compaction completed. */
		ok: boolean;
		/** The failure, when ok is false. */
		error: Error | null;
		/** True when we stopped waiting because the compaction never settled. */
		timedOut?: boolean;
	}

	/**
	 * Run ctx.compact() and wait for it to settle. ctx.compact() is fire-and-forget,
	 * so completion is observed through its onComplete/onError callbacks — with a
	 * timeout as a deadlock guard, because neither callback fires if Pi's internal
	 * abort/summarization step stalls. All UI access is guarded: if the session was
	 * replaced or a newer compaction started, stale callbacks leave the UI alone.
	 */
	const compactAndWait = (ctx: ExtensionContext, gen: number, timeoutMs: number): Promise<CompactionOutcome> =>
		new Promise<CompactionOutcome>((resolve) => {
			const seq = ++compactSequence;
			const fresh = () => gen === sessionGeneration && seq === compactSequence;
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (outcome: CompactionOutcome) => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				resolve(outcome);
			};
			timer = setTimeout(() => {
				if (fresh()) setStatus(ctx, "compact stalled, giving up", "warning");
				finish({
					ok: false,
					error: new Error(`compaction did not settle within ${Math.round(timeoutMs / 1000)}s`),
					timedOut: true,
				});
			}, timeoutMs);
			// Note: deliberately NOT unref()'d — the input handler is awaiting this
			// timer as its only liveness guarantee; finish() clears it on settle.
			try {
				ctx.compact({
					onComplete: () => {
						if (fresh()) clearStatus(ctx);
						finish({ ok: true, error: null });
					},
					onError: (error) => {
						if (fresh() && !isSoftCompactionError(error) && !isAbortError(error)) {
							setStatus(ctx, "compact failed", "error");
						}
						finish({ ok: false, error });
					},
				});
			} catch (error) {
				finish({ ok: false, error: error instanceof Error ? error : new Error(String(error)) });
			}
		});

	pi.on("session_start", (_event, ctx) => {
		sessionGeneration++;
		// A never-settling compaction promise from the old session must not block
		// preflight in the new one (Pi itself rejects prompts while a compaction
		// is genuinely still running, so dropping the reference is safe).
		inFlight = null;
		clearStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
		inFlight = null;
	});

	pi.registerCommand("compact-threshold", {
		description: `Show or set auto-compaction threshold (usage: /compact-threshold [${MIN_THRESHOLD}-${MAX_THRESHOLD - 1}])`,
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify(`Auto-compaction threshold: ${loadConfig(config).threshold}%`, "info");
				return;
			}

			if (input.toLowerCase() === "reset") {
				try {
					rmSync(CONFIG_FILE, { force: true });
					config = DEFAULT_CONFIG;
					ctx.ui.notify(`Auto-compaction threshold reset to ${config.threshold}%`, "info");
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
				config = { ...config, threshold: value };
				ctx.ui.notify(`Auto-compaction threshold set to ${config.threshold}%`, "info");
			} catch {
				ctx.ui.notify("Could not save auto-compaction threshold", "error");
			}
		},
	});

	// Status-only: show when the context is already past the threshold and the next
	// prompt will trigger a preflight compaction. No compaction happens here.
	pi.on("turn_end", (_event, ctx) => {
		config = loadConfig(config);
		const usage = getValidUsage(ctx);
		if (!usage) {
			clearStatus(ctx);
			return;
		}
		const percent = (usage.tokens / usage.contextWindow) * 100;
		if (percent >= config.threshold) {
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

		// Re-read per prompt so /compact-threshold changes from other sessions apply here.
		config = loadConfig(config);
		const usage = getValidUsage(ctx);
		if (!usage) return { action: "continue" };

		const content =
			event.images && event.images.length > 0
				? [{ type: "text" as const, text: event.text }, ...event.images]
				: event.text;
		const projected = usage.tokens + estimateTokens({ role: "user", content, timestamp: Date.now() });
		if (projected < usage.contextWindow * (config.threshold / 100)) return { action: "continue" };

		const gen = sessionGeneration;
		const projectedPercent = ((projected / usage.contextWindow) * 100).toFixed(1);
		setStatus(ctx, `projected ${projectedPercent}% · compacting before send`, "warning");

		// Serialize concurrent prompts that race past Pi's own compaction guard:
		// reuse the in-flight compaction instead of starting a second one.
		if (!inFlight) {
			const current = compactAndWait(ctx, gen, config.compactTimeoutMs);
			inFlight = current;
			void current.finally(() => {
				if (inFlight === current) inFlight = null;
			});
		}
		const outcome = await inFlight;
		if (gen !== sessionGeneration) return { action: "continue" };

		if (outcome.error) {
			if (isSoftCompactionError(outcome.error) || outcome.timedOut || isAbortError(outcome.error)) {
				// Already-minimal context, a stalled compaction we stopped waiting for, or a
				// user-cancelled compaction: sending is safe and Pi's built-in compaction
				// (including overflow recovery) remains the final safety net.
				notifySafe(ctx, `Auto-compact skipped: ${outcome.error.message}. Sending prompt anyway.`, "warning");
			} else {
				const restored = restorePromptText(ctx, event.text);
				notifySafe(
					ctx,
					`Auto-compact failed: ${outcome.error.message}. Prompt not sent — ${restored ? "text restored to the editor" : "resubmit when ready"}.`,
					"error",
				);
				return { action: "handled" };
			}
		}
		return { action: "continue" };
	});
}
