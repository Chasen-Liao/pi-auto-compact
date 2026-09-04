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
/**
 * Safety ceiling for one preflight compaction. Pi's ctx.compact() has no
 * cancel handle and its internal abort/summarization steps can stall without
 * ever invoking onComplete/onError (verified against SDK 0.84.3/0.84.4 — the
 * compact wrapper is byte-identical in both). Without this ceiling a stalled
 * compaction leaves the awaiting input handler suspended forever: in print
 * mode the event loop drains and the prompt is silently dropped; in the TUI
 * the session wedges until restart.
 */
const DEFAULT_COMPACT_TIMEOUT_MS = 30_000;
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
	// Merge into the existing file so unknown keys (e.g. compactTimeoutMs)
	// survive, then write to a temp file and rename, so a crash can never leave
	// a half-written config.
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

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	/** Bumped on session start/shutdown so async callbacks can detect a replaced session. */
	let sessionGeneration = 0;
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
	 * abort/summarization step stalls. The timer is deliberately NOT unref()'d: the
	 * awaiting input handler has no other liveness guarantee (without it the event
	 * loop drains and a print-mode prompt is silently dropped); finish() clears it
	 * on settle so it never delays a healthy exit. UI access is guarded: if the
	 * session was replaced mid-compaction, stale callbacks leave the UI alone.
	 */
	const compactAndWait = (ctx: ExtensionContext, gen: number, timeoutMs: number): Promise<CompactionOutcome> =>
		new Promise<CompactionOutcome>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (outcome: CompactionOutcome) => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				resolve(outcome);
			};
			timer = setTimeout(() => {
				if (gen === sessionGeneration) setStatus(ctx, "compact timed out", "warning");
				finish({
					ok: false,
					error: new Error(`Compaction timed out after ${Math.round(timeoutMs / 1000)}s`),
					timedOut: true,
				});
			}, timeoutMs);
			try {
				ctx.compact({
					onComplete: () => {
						if (gen === sessionGeneration) clearStatus(ctx);
						finish({ ok: true, error: null });
					},
					onError: (error) => {
						if (gen === sessionGeneration && !isSoftCompactionError(error)) {
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
		clearStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
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
			// Pi's own status bar already shows usage/window; only add the actionable hint.
			setStatus(ctx, "compact before next prompt", "warning");
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
			if (isSoftCompactionError(outcome.error)) {
				// The context is already minimal (e.g. compacted seconds ago); sending is safe.
				notifySafe(ctx, `Auto-compact skipped: ${outcome.error.message}. Sending prompt anyway.`, "warning");
			} else {
				// Hard failure or timeout: the context state is uncertain, so keep the
				// fail-closed contract — the prompt is not sent and the user resubmits
				// (recall it with the editor history). Note Pi's own compaction mutex
				// stays locked while ctx.compact() is genuinely still running, so a
				// resubmit queues until the background compaction settles.
				const reason = outcome.timedOut
					? `Auto-compact timed out after ${Math.round(config.compactTimeoutMs / 1000)}s`
					: `Auto-compact failed: ${outcome.error.message}`;
				notifySafe(ctx, `${reason}. Prompt not sent — resubmit when ready.`, "error");
				return { action: "handled" };
			}
		}
		return { action: "continue" };
	});
}
