import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	DEFAULT_COMPACTION_SETTINGS,
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
/** Pi's own settings file. Alignment writes one compaction budget per model into it. */
const SETTINGS_FILE = join(getAgentDir(), "settings.json");
/** Compaction errors meaning "the context is already as small as it can get" — safe to send the prompt anyway. */
const SOFT_COMPACT_ERRORS = ["Nothing to compact", "Already compacted"];

interface PluginConfig {
	/** Compact before sending a prompt once the projected context reaches this percent. */
	threshold: number;
	/** Also aim Pi's own compaction threshold (the mid-run check between tool batches) at `threshold`. */
	alignPiThreshold: boolean;
	/** reserveTokens this extension wrote, keyed by `provider/model`, so `align off` can undo exactly those. */
	alignedReserveTokens: Record<string, number>;
}

function defaultConfig(): PluginConfig {
	return {
		threshold: DEFAULT_THRESHOLD,
		alignPiThreshold: false,
		alignedReserveTokens: {},
	};
}

function parseConfig(raw: unknown, fallback: PluginConfig): PluginConfig {
	const source = (raw ?? {}) as Partial<PluginConfig>;
	const { threshold, alignedReserveTokens } = source;
	return {
		threshold:
			typeof threshold === "number" &&
			Number.isFinite(threshold) &&
			threshold >= MIN_THRESHOLD &&
			threshold < MAX_THRESHOLD
				? threshold
				: fallback.threshold,
		alignPiThreshold:
			typeof source.alignPiThreshold === "boolean"
				? source.alignPiThreshold
				: fallback.alignPiThreshold,
		alignedReserveTokens:
			alignedReserveTokens &&
			typeof alignedReserveTokens === "object" &&
			!Array.isArray(alignedReserveTokens)
				? { ...alignedReserveTokens }
				: fallback.alignedReserveTokens,
	};
}

/** Read the config from disk, keeping the last-known values when missing/invalid (hot reload). */
function loadConfig(fallback: PluginConfig): PluginConfig {
	try {
		return parseConfig(JSON.parse(readFileSync(CONFIG_FILE, "utf8")), fallback);
	} catch {
		// Use the fallback when no valid config exists.
		return fallback;
	}
}

/**
 * Read-modify-write a JSON object file through a temp file and a rename, so a
 * crash can never leave it half-written. Keys this extension does not know
 * about survive. Callers skip the call when nothing has to change.
 */
function updateJsonFile(
	file: string,
	update: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
	mkdirSync(dirname(file), { recursive: true });
	let current: Record<string, unknown> = {};
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw))
			current = raw as Record<string, unknown>;
	} catch {
		// Start from an empty object when the file is missing or corrupt.
	}
	const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(
		tempFile,
		`${JSON.stringify(update(current), null, 2)}\n`,
		"utf8",
	);
	try {
		renameSync(tempFile, file);
	} catch (error) {
		try {
			rmSync(tempFile, { force: true });
		} catch {
			// Best-effort cleanup; the rename error matters more.
		}
		throw error;
	}
}

function writeConfig(patch: Partial<PluginConfig>): void {
	updateJsonFile(CONFIG_FILE, (current) => ({ ...current, ...patch }));
}

type StatusKind = "info" | "warning" | "error";

function setStatus(
	ctx: ExtensionContext,
	text: string | undefined,
	kind: StatusKind = "info",
): void {
	if (!ctx.hasUI) return;
	try {
		if (text === undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
		else
			ctx.ui.setStatus(
				STATUS_KEY,
				kind === "info" ? text : ctx.ui.theme.fg(kind, text),
			);
	} catch {
		// The ctx may be stale after a session switch/reload; never break the prompt flow over status updates.
	}
}

/** Context usage worth acting on, or undefined when tokens are unknown (e.g. right after compaction). */
function getValidUsage(
	ctx: ExtensionContext,
): { tokens: number; contextWindow: number } | undefined {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens == null || usage.contextWindow <= 0)
		return undefined;
	return { tokens: usage.tokens, contextWindow: usage.contextWindow };
}

/** Fire-and-forget notify that survives a stale ctx. */
function notifySafe(
	ctx: ExtensionContext,
	text: string,
	kind: StatusKind,
): void {
	try {
		ctx.ui.notify(text, kind);
	} catch {
		// Ignore UI failures.
	}
}

function isSoftCompactionError(error: Error): boolean {
	return SOFT_COMPACT_ERRORS.some((message) => error.message.includes(message));
}

/** Pi's effective compaction settings, typed from the API so it tracks pi's own types. */
type PiCompaction = ReturnType<ExtensionAPI["getSettings"]>["compaction"];

function readPiCompaction(pi: ExtensionAPI): PiCompaction {
	try {
		return pi.getSettings().compaction;
	} catch {
		// getSettings() throws until the extension runtime finishes initializing.
		return undefined;
	}
}

/** Pi resolves the reserve per model override, then the global value, then its built-in default. */
function piReserveTokens(compaction: PiCompaction, key: string): number {
	return (
		compaction?.modelOverrides?.[key]?.reserveTokens ??
		compaction?.reserveTokens ??
		DEFAULT_COMPACTION_SETTINGS.reserveTokens
	);
}

/** Percent of the context window at which Pi's own threshold checks start compacting. */
function piTriggerPercent(
	compaction: PiCompaction,
	key: string,
	contextWindow: number,
): number {
	return (
		((contextWindow - piReserveTokens(compaction, key)) / contextWindow) * 100
	);
}

export default function (pi: ExtensionAPI) {
	/** Current config; re-read from disk before each prompt and turn (hot reload). */
	let config = loadConfig(defaultConfig());
	/** Last status written, so repeated identical updates stay out of the UI. */
	let lastStatus: string | undefined;
	/** Bumped on session start/shutdown so async callbacks can detect a replaced session. */
	let sessionGeneration = 0;
	/** Shared in-flight preflight compaction; resolves to the failure (or null) once the compaction attempt settles. */
	let inFlight: Promise<Error | null> | null = null;

	/** setStatus that skips no-op writes; tool calls repeat the same pressure line many times per run. */
	const setStatusOnce = (
		ctx: ExtensionContext,
		text: string | undefined,
		kind: StatusKind = "info",
	): void => {
		const next = text === undefined ? undefined : `${kind}:${text}`;
		if (next === lastStatus) return;
		lastStatus = next;
		setStatus(ctx, text, kind);
	};

	const modelKey = (model: ExtensionContext["model"]): string | undefined =>
		model ? `${model.provider}/${model.id}` : undefined;

	const rememberManaged = (key: string, reserveTokens: number): void => {
		config.alignedReserveTokens = { ...config.alignedReserveTokens, [key]: reserveTokens };
		writeConfig({ alignedReserveTokens: config.alignedReserveTokens });
	};

	const forgetManaged = (key: string): void => {
		const { [key]: _dropped, ...rest } = config.alignedReserveTokens;
		config.alignedReserveTokens = rest;
		writeConfig({ alignedReserveTokens: rest });
	};

	/**
	 * Point Pi's own compaction threshold at the configured percentage for one
	 * model, by writing a `compaction.modelOverrides` reserve: Pi compacts
	 * whenever projected tokens exceed `contextWindow - reserveTokens`, and that
	 * check also runs between tool batches, so aligning it is what makes a
	 * mid-run compaction happen at our threshold and the run continue.
	 *
	 * A reserve we did not write belongs to the user and is never touched.
	 */
	const syncPiThreshold = (
		model: ExtensionContext["model"],
	): "unchanged" | "aligned" | "owned-by-user" => {
		const key = modelKey(model);
		const contextWindow = model?.contextWindow ?? 0;
		if (!key || contextWindow <= 0) return "unchanged";
		const compaction = readPiCompaction(pi);
		const current = compaction?.modelOverrides?.[key]?.reserveTokens;
		const managed = config.alignedReserveTokens[key];
		if (
			current === undefined &&
			managed === undefined &&
			compaction?.reserveTokens !== undefined
		) {
			// The user set a compaction budget of their own; a per-model entry would silently beat it.
			return "owned-by-user";
		}
		if (current !== undefined && current !== managed) {
			// The value is not the one we wrote, so the user configured it.
			if (managed !== undefined) forgetManaged(key);
			return "owned-by-user";
		}
		const reserveTokens = Math.max(
			0,
			Math.round(contextWindow * (1 - config.threshold / 100)),
		);
		if (current === reserveTokens) return "unchanged";
		updateJsonFile(SETTINGS_FILE, (file) => {
			const block = { ...((file.compaction ?? {}) as Record<string, unknown>) };
			const overrides = { ...((block.modelOverrides ?? {}) as Record<string, unknown>) };
			overrides[key] = { ...(overrides[key] as object), reserveTokens };
			return { ...file, compaction: { ...block, modelOverrides: overrides } };
		});
		rememberManaged(key, reserveTokens);
		return "aligned";
	};

	/** Drop every compaction reserve this extension wrote; returns whether Pi's file changed. */
	const clearPiAlignment = (): boolean => {
		const managed = Object.entries(config.alignedReserveTokens);
		if (managed.length === 0) return false;
		let changed = false;
		updateJsonFile(SETTINGS_FILE, (file) => {
			const next = { ...file };
			const block = { ...((file.compaction ?? {}) as Record<string, unknown>) };
			const overrides = { ...((block.modelOverrides ?? {}) as Record<string, unknown>) };
			for (const [key, reserveTokens] of managed) {
				const override = overrides[key] as { reserveTokens?: number } | undefined;
				// Leave a reserve the user has since changed alone.
				if (override?.reserveTokens !== reserveTokens) continue;
				delete overrides[key];
				changed = true;
			}
			if (Object.keys(overrides).length > 0) block.modelOverrides = overrides;
			else delete block.modelOverrides;
			if (Object.keys(block).length === 0) delete next.compaction;
			else next.compaction = block;
			return next;
		});
		config.alignedReserveTokens = {};
		writeConfig({ alignedReserveTokens: {} });
		return changed;
	};

	/** Keep Pi's threshold aligned, telling the user only when Pi's file actually changed. */
	const refreshAlignment = (
		ctx: ExtensionContext,
		model: ExtensionContext["model"] = ctx.model,
	): void => {
		config = loadConfig(config);
		if (!config.alignPiThreshold) return;
		try {
			if (syncPiThreshold(model) !== "aligned") return;
		} catch {
			// Never turn a settings write problem into an extension error at session start.
			notifySafe(ctx, "Could not align pi's compaction threshold", "error");
			return;
		}
		notifySafe(
			ctx,
			`Pi compaction aligned to ${config.threshold}% for ${modelKey(model)} — run /reload to apply.`,
			"info",
		);
	};

	/** One-line description of where Pi's own compaction currently kicks in. */
	const describePiTrigger = (ctx: ExtensionContext): string | undefined => {
		const key = modelKey(ctx.model);
		const contextWindow = ctx.model?.contextWindow ?? 0;
		if (!key || contextWindow <= 0) return undefined;
		const compaction = readPiCompaction(pi);
		const current = compaction?.modelOverrides?.[key]?.reserveTokens;
		const owned = current !== undefined && current === config.alignedReserveTokens[key];
		const origin =
			current === undefined && compaction?.reserveTokens === undefined
				? "pi default"
				: owned
					? "set by pi-auto-compact"
					: "your settings";
		return `Pi compacts mid-run at ${piTriggerPercent(compaction, key, contextWindow).toFixed(0)}% (reserveTokens ${piReserveTokens(compaction, key)}, ${origin})`;
	};

	/**
	 * Run ctx.compact() and wait for it to settle. ctx.compact() is fire-and-forget,
	 * so completion is observed through its onComplete/onError callbacks (Pi invokes
	 * exactly one). Resolves to the failure, or null on success. All UI access is
	 * guarded: if the session was replaced mid-compaction (gen mismatch) the old
	 * session's status bar is left alone.
	 */
	const compactAndWait = (
		ctx: ExtensionContext,
		gen: number,
	): Promise<Error | null> =>
		new Promise<Error | null>((resolve) => {
			try {
				ctx.compact({
					onComplete: () => {
						if (gen === sessionGeneration) setStatusOnce(ctx, undefined);
						resolve(null);
					},
					onError: (error) => {
						if (gen === sessionGeneration && !isSoftCompactionError(error)) {
							setStatusOnce(ctx, "compact failed", "error");
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
		lastStatus = undefined;
		setStatus(ctx, undefined);
		refreshAlignment(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
	});

	pi.on("model_select", (event, ctx) => {
		refreshAlignment(ctx, event.model);
	});

	pi.registerCommand("compact-threshold", {
		description: `Show or set the auto-compaction threshold (usage: /compact-threshold [${MIN_THRESHOLD}-${MAX_THRESHOLD - 1}] | align on|off | reset)`,
		handler: async (args, ctx) => {
			// Hot reload first: the value may have changed in another session.
			config = loadConfig(config);
			const [head, tail] = args.trim().split(/\s+/);
			const input = head?.toLowerCase() ?? "";

			if (input === "align") {
				const on = tail?.toLowerCase() === "on";
				const off = tail?.toLowerCase() === "off";
				if (!on && !off) {
					ctx.ui.notify("Usage: /compact-threshold align on|off", "warning");
					return;
				}
				config.alignPiThreshold = on;
				try {
					writeConfig({ alignPiThreshold: on });
					if (off) {
						const changed = clearPiAlignment();
						ctx.ui.notify(
							changed
								? "Mid-run compaction back to pi's own threshold — run /reload to apply"
								: "Mid-run compaction back to pi's own threshold",
							"info",
						);
					} else {
						const result = syncPiThreshold(ctx.model);
						ctx.ui.notify(
							result === "aligned"
								? `Mid-run compaction now follows ${config.threshold}% for ${modelKey(ctx.model) ?? "the current model"} — run /reload to apply`
								: result === "owned-by-user"
									? "Pi already has a compaction budget for this model; leaving it alone"
									: "Mid-run compaction follows the threshold (nothing to write)",
							result === "owned-by-user" ? "warning" : "info",
						);
					}
				} catch {
					ctx.ui.notify("Could not save the compaction alignment", "error");
					return;
				}
				lastStatus = undefined;
				return;
			}

			if (!head) {
				const lines = [
					`Auto-compaction threshold: ${config.threshold}%`,
					describePiTrigger(ctx) ?? "Pi compaction: model context window unknown",
				];
				if (!config.alignPiThreshold)
					lines.push(
						`Run /compact-threshold align on to compact mid-run at ${config.threshold}% too`,
					);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (input === "reset") {
				try {
					clearPiAlignment();
					rmSync(CONFIG_FILE, { force: true });
					config = defaultConfig();
					lastStatus = undefined;
					ctx.ui.notify(
						`Auto-compaction threshold reset to ${config.threshold}%`,
						"info",
					);
				} catch {
					ctx.ui.notify(
						"Could not reset auto-compaction threshold",
						"error",
					);
				}
				return;
			}

			const value = Number(head.replace(/%$/, ""));
			if (
				!Number.isFinite(value) ||
				value < MIN_THRESHOLD ||
				value >= MAX_THRESHOLD
			) {
				ctx.ui.notify(
					`Usage: /compact-threshold [${MIN_THRESHOLD}-${MAX_THRESHOLD - 1}] | align on|off | reset`,
					"warning",
				);
				return;
			}

			try {
				// Persist first, then update memory, so a failed save never desyncs the two.
				writeConfig({ threshold: value });
				config = loadConfig({ ...config, threshold: value });
				lastStatus = undefined;
			} catch {
				ctx.ui.notify("Could not save auto-compaction threshold", "error");
				return;
			}
			ctx.ui.notify(
				`Auto-compaction threshold set to ${config.threshold}%`,
				"info",
			);
			refreshAlignment(ctx);
		},
	});

	// Status-only: show when the context is already past the threshold and the next
	// prompt will trigger a preflight compaction. No compaction happens here.
	pi.on("turn_end", (_event, ctx) => {
		config = loadConfig(config);
		const usage = getValidUsage(ctx);
		if (!usage) {
			setStatusOnce(ctx, undefined);
			return;
		}
		const percent = (usage.tokens / usage.contextWindow) * 100;
		if (percent >= config.threshold) {
			// Pi's own status bar already shows usage/window; only add the actionable hint.
			setStatusOnce(ctx, "compact before next prompt", "warning");
		} else {
			setStatusOnce(ctx, undefined);
		}
	});

	// Mid-run check: context grows with every tool result, and Pi only compacts
	// between tool batches (AgentSession.prepareNextTurn), not before a call. This
	// handler deliberately never compacts — ctx.compact() aborts the running turn
	// (verified on pi 0.99.1) and drops the turn's work. It only reports which
	// compaction is pending: ours before the next prompt, Pi's after this batch.
	pi.on("tool_call", (_event, ctx) => {
		const usage = getValidUsage(ctx);
		if (!usage) return;
		const percent = (usage.tokens / usage.contextWindow) * 100;
		if (percent < config.threshold) {
			setStatusOnce(ctx, undefined);
			return;
		}
		const key = modelKey(ctx.model);
		const trigger = key
			? piTriggerPercent(readPiCompaction(pi), key, usage.contextWindow)
			: undefined;
		setStatusOnce(
			ctx,
			trigger !== undefined && percent >= trigger
				? `context ${percent.toFixed(0)}% · compacting after this tool batch`
				: `context ${percent.toFixed(0)}% · pi compacts at ${trigger?.toFixed(0) ?? "?"}% between tool batches`,
			"warning",
		);
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
		const projected =
			usage.tokens +
			estimateTokens({ role: "user", content, timestamp: Date.now() });
		if (projected < usage.contextWindow * (config.threshold / 100))
			return { action: "continue" };

		const gen = sessionGeneration;
		const projectedPercent = ((projected / usage.contextWindow) * 100).toFixed(1);
		setStatusOnce(
			ctx,
			`projected ${projectedPercent}% · compacting before send`,
			"warning",
		);

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
				notifySafe(
					ctx,
					`Auto-compact skipped: ${error.message}. Sending prompt anyway.`,
					"warning",
				);
			} else {
				// Fail-closed: the context state is uncertain, so the prompt is not sent
				// and the user resubmits (recall it from the editor history). Note Pi's
				// compaction mutex stays locked while ctx.compact() is genuinely still
				// running, so a resubmit queues until the background compaction settles.
				notifySafe(
					ctx,
					`Auto-compact failed: ${error.message}. Prompt not sent — resubmit when ready.`,
					"error",
				);
				return { action: "handled" };
			}
		}
		return { action: "continue" };
	});
}
