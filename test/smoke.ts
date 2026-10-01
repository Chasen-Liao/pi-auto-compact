/**
 * Mock smoke test for extensions/auto-compact.ts.
 *
 * Runs with plain Node (>=22.18 / >=23.6 native TS type stripping):
 *   npm test
 *
 * Mocks the ExtensionAPI surface (events, commands, ctx.ui, ctx.compact) and
 * covers: threshold math, soft-error fail-open, hard-fail fail-closed,
 * concurrent-prompt serialization, session-switch guarding, config
 * persistence/hot reload, the mid-run tool_call check, and Pi threshold
 * alignment. The real pi SDK is imported for
 * estimateTokens/getAgentDir; no agent state is touched because
 * PI_CODING_AGENT_DIR points at a throwaway temp dir set before the
 * extension module resolves CONFIG_FILE.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-auto-compact-smoke-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const CONFIG_FILE = join(agentDir, "pi-auto-compact.json");
const SETTINGS_FILE = join(agentDir, "settings.json");
/** deepseek-flash-shaped model: 1M window, so 78% leaves a 220k reserve. */
const MODEL = { provider: "deepseek", id: "deepseek-flash", contextWindow: 1_000_000 };

const { default: createExtension } = await import(
	"../extensions/auto-compact.ts"
);

type Handler = (event: any, ctx: any) => any;

interface MockPi {
	pi: any;
	events: Map<string, Handler[]>;
	commands: Map<string, { description: string; handler: Handler }>;
}

function makePi(): MockPi {
	const events = new Map<string, Handler[]>();
	const commands = new Map<string, { description: string; handler: Handler }>();
	const pi = {
		on(name: string, handler: Handler) {
			if (!events.has(name)) events.set(name, []);
			events.get(name)!.push(handler);
		},
		registerCommand(
			name: string,
			def: { description: string; handler: Handler },
		) {
			commands.set(name, def);
		},
		// Pi serves the merged global+project settings from disk; the tests only
		// ever write the global one.
		getSettings(): Record<string, unknown> {
			try {
				return JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
			} catch {
				return {};
			}
		},
	};
	return { pi, events, commands };
}

function install(pi: MockPi) {
	createExtension(pi.pi);
	return {
		fireInput: (event: any, ctx: any) =>
			pi.events.get("input")![0]!({ source: "interactive", ...event }, ctx),
		fireTurnEnd: (ctx: any) => pi.events.get("turn_end")!.map((h) => h({}, ctx)),
		fireSessionStart: (ctx: any) =>
			pi.events.get("session_start")!.map((h) => h({}, ctx)),
		fireToolCall: (ctx: any, toolName = "bash") =>
			pi.events.get("tool_call")!.map((h) => h({ toolName, input: {} }, ctx)),
		fireModelSelect: (ctx: any) =>
			pi.events
				.get("model_select")!
				.map((h) => h({ model: MODEL, previousModel: undefined, source: "set" }, ctx)),
		command: (name: string) => pi.commands.get(name)!,
	};
}

interface CompactHandler {
	onComplete?: (result: any) => void;
	onError?: (error: Error) => void;
}

interface CtxHarness {
	ctx: any;
	compacts: CompactHandler[];
	statuses: (string | undefined)[];
	notifies: { text: string; kind: string }[];
}

function makeCtx(opts: {
	usage?: { tokens: number | null; contextWindow: number };
	onCompact?: (handlers: CompactHandler) => void;
	model?: { provider: string; id: string; contextWindow: number } | undefined;
}): CtxHarness {
	const compacts: CompactHandler[] = [];
	const harness: CtxHarness = {
		ctx: {
			hasUI: true,
			model: "model" in opts ? opts.model : MODEL,
			getContextUsage: () => opts.usage,
			compact(handlers: CompactHandler) {
				compacts.push(handlers);
				opts.onCompact?.(handlers);
			},
			ui: {
				setStatus: (_key: string, text: string | undefined) => {
					harness.statuses.push(text);
				},
				notify: (text: string, kind: string) => {
					harness.notifies.push({ text, kind });
				},
				theme: { fg: (_kind: string, text: string) => text },
			},
		},
		compacts,
		statuses: [],
		notifies: [],
	};
	return harness;
}

function writeConfig(value: Record<string, unknown>) {
	writeFileSync(CONFIG_FILE, JSON.stringify(value, null, 2), "utf8");
}

function writePiSettings(value: Record<string, unknown>) {
	writeFileSync(SETTINGS_FILE, JSON.stringify(value, null, 2), "utf8");
}

function readPiSettings(): Record<string, any> {
	try {
		return JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
	} catch {
		return {};
	}
}

// --- baseline gating ---------------------------------------------------------

test("below threshold: prompt flows through without compaction", async () => {
	const pi = install(makePi());
	const h = makeCtx({ usage: { tokens: 10, contextWindow: 100 } });
	const res = await pi.fireInput({ text: "hi" }, h.ctx);
	assert.equal(res.action, "continue");
	assert.equal(h.compacts.length, 0);
});

test("unknown usage or queued steer/followUp: preflight skipped", async () => {
	const pi = install(makePi());
	const noUsage = makeCtx({ usage: undefined });
	assert.equal(
		(await pi.fireInput({ text: "hi" }, noUsage.ctx)).action,
		"continue",
	);
	assert.equal(noUsage.compacts.length, 0);

	const nullTokens = makeCtx({ usage: { tokens: null, contextWindow: 100 } });
	assert.equal(
		(await pi.fireInput({ text: "hi" }, nullTokens.ctx)).action,
		"continue",
	);

	const queued = makeCtx({ usage: { tokens: 99, contextWindow: 100 } });
	const res = await pi.fireInput(
		{ text: "hi", streamingBehavior: "steer" },
		queued.ctx,
	);
	assert.equal(res.action, "continue");
	assert.equal(queued.compacts.length, 0);
});

test("projected over threshold: compact once, then send", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: (c) => c.onComplete?.({}),
	});
	const res = await pi.fireInput({ text: "a long prompt goes here" }, h.ctx);
	assert.equal(res.action, "continue");
	assert.equal(h.compacts.length, 1);
	assert.match(h.statuses[0]!, /projected/);
	assert.equal(h.statuses.at(-1), undefined, "status cleared after success");
});

test("image prompts project image cost into usage (text alone stays below)", async () => {
	const pi = install(makePi());
	const textOnly = makeCtx({ usage: { tokens: 76, contextWindow: 100 } });
	await pi.fireInput({ text: "hi" }, textOnly.ctx);
	assert.equal(
		textOnly.compacts.length,
		0,
		"76 + ~1 token stays under the 78% line",
	);

	const withImage = makeCtx({
		usage: { tokens: 76, contextWindow: 100 },
		onCompact: (c) => c.onComplete?.({}),
	});
	const res = await pi.fireInput(
		{
			text: "hi",
			images: [{ type: "image", data: "Zm9v", mimeType: "image/png" }],
		},
		withImage.ctx,
	);
	assert.equal(res.action, "continue");
	assert.equal(
		withImage.compacts.length,
		1,
		"image adds 4800 chars, pushing projection past the line",
	);
});

// --- failure classification --------------------------------------------------

test("soft errors fail open without an error status", async () => {
	for (const message of [
		"Nothing to compact (session too small)",
		"Already compacted",
	]) {
		const pi = install(makePi());
		const h = makeCtx({
			usage: { tokens: 90, contextWindow: 100 },
			onCompact: (c) => c.onError?.(new Error(message)),
		});
		const res = await pi.fireInput({ text: "hi" }, h.ctx);
		assert.equal(res.action, "continue", message);
		assert.equal(h.notifies.at(-1)?.kind, "warning", message);
		assert.match(h.notifies.at(-1)!.text, /Sending prompt anyway/, message);
		assert.ok(!h.statuses.includes("compact failed"), message);
	}
});

test("aborted compaction is fail-closed: prompt not sent", async () => {
	const pi = install(makePi());
	const error = new Error("Compaction cancelled");
	error.name = "AbortError";
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: (c) => c.onError?.(error),
	});
	const res = await pi.fireInput({ text: "hi" }, h.ctx);
	assert.equal(res.action, "handled");
	assert.equal(h.notifies.at(-1)?.kind, "error");
	assert.match(h.notifies.at(-1)!.text, /Prompt not sent/);
	assert.ok(h.statuses.includes("compact failed"));
});

test("hard error: prompt not sent", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: (c) => c.onError?.(new Error("provider exploded")),
	});
	const res = await pi.fireInput({ text: "important long prompt" }, h.ctx);
	assert.equal(res.action, "handled");
	assert.equal(h.notifies.at(-1)?.kind, "error");
	assert.match(h.notifies.at(-1)!.text, /Prompt not sent — resubmit when ready/);
});

// --- concurrency / session guarding -------------------------------------------

test("two prompts racing past the guard share one compaction", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: () => undefined,
	});
	const p1 = pi.fireInput({ text: "first" }, h.ctx);
	const p2 = pi.fireInput({ text: "second" }, h.ctx);
	h.compacts[0]!.onComplete?.({});
	assert.equal((await p1).action, "continue");
	assert.equal((await p2).action, "continue");
	assert.equal(h.compacts.length, 1);
});

test("session switch mid-compaction: stale callbacks never touch UI", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: () => undefined,
	});
	const pending = pi.fireInput({ text: "hi" }, h.ctx);
	pi.fireSessionStart(makeCtx({ usage: undefined }).ctx); // bumps generation
	h.compacts[0]!.onComplete?.({});
	assert.equal((await pending).action, "continue");
	assert.equal(
		h.statuses.length,
		1,
		"only the pre-compaction status was written",
	);
	assert.equal(h.notifies.length, 0);
});

// --- configuration -------------------------------------------------------------

test("turn_end status reflects the threshold and clears below it", async () => {
	writeConfig({ threshold: 50 });
	try {
		const pi = install(makePi());
		const hot = makeCtx({ usage: { tokens: 90, contextWindow: 100 } });
		pi.fireTurnEnd(hot.ctx);
		assert.match(hot.statuses.at(-1)!, /compact before next prompt/);
		const cool = makeCtx({ usage: { tokens: 10, contextWindow: 100 } });
		pi.fireTurnEnd(cool.ctx);
		assert.equal(cool.statuses.at(-1), undefined);
	} finally {
		writeConfig({ threshold: 78 });
	}
});

test("threshold hot-reloads from disk between prompts", async () => {
	writeConfig({ threshold: 95 });
	const pi = install(makePi());
	const calm = makeCtx({ usage: { tokens: 90, contextWindow: 100 } });
	await pi.fireInput({ text: "hi" }, calm.ctx);
	assert.equal(calm.compacts.length, 0, "90% < 95% threshold");

	writeConfig({ threshold: 50 });
	const hot = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: (c) => c.onComplete?.({}),
	});
	await pi.fireInput({ text: "hi" }, hot.ctx);
	assert.equal(hot.compacts.length, 1, "90% >= 50% after hot reload");

	// Out-of-range hand edits must fall back to the last valid value (92), not the tampered one.
	writeConfig({ threshold: 92 });
	const above92 = makeCtx({ usage: { tokens: 90, contextWindow: 100 } });
	await pi.fireInput({ text: "hi" }, above92.ctx);
	assert.equal(above92.compacts.length, 0, "90% < 92%");

	writeConfig({ threshold: 25 }); // below MIN_THRESHOLD: reject, keep 92
	const tampered = makeCtx({ usage: { tokens: 90, contextWindow: 100 } });
	await pi.fireInput({ text: "hi" }, tampered.ctx);
	assert.equal(tampered.compacts.length, 0, "tampered 25% must not take effect");
});

test("/compact-threshold persists atomically, merges keys, validates input", async () => {
	writeConfig({ threshold: 78, compactTimeoutMs: 5000 });
	const pi = install(makePi());
	const cmd = pi.command("compact-threshold");
	const h = makeCtx({ usage: undefined });

	await cmd.handler("", h.ctx);
	assert.match(h.notifies.at(-1)!.text, /^Auto-compaction threshold: 78%/);

	await cmd.handler("62", h.ctx);
	const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	assert.equal(saved.threshold, 62);
	assert.equal(
		saved.compactTimeoutMs,
		5000,
		"unknown config keys survive a save",
	);

	for (const bad of ["0", "20", "abc", "99", "100", "-5"]) {
		const before = readFileSync(CONFIG_FILE, "utf8");
		await cmd.handler(bad, h.ctx);
		assert.equal(h.notifies.at(-1)!.kind, "warning", bad);
		assert.equal(
			readFileSync(CONFIG_FILE, "utf8"),
			before,
			`${bad} must not touch the file`,
		);
	}

	await cmd.handler("reset", h.ctx);
	assert.ok(!existsSync(CONFIG_FILE), "reset removes the config file");
});

// --- mid-run (tool_call) check ------------------------------------------------

test("tool_call below threshold stays silent and never compacts", () => {
	const pi = install(makePi());
	const h = makeCtx({ usage: { tokens: 10, contextWindow: 100 } });
	pi.fireToolCall(h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.compacts.length, 0, "a tool call must never trigger ctx.compact()");
});

test("tool_call above threshold reports pi's own mid-run trigger", () => {
	const pi = install(makePi());
	// 80% usage on a 1M window; pi's default reserve leaves a ~98% trigger.
	const h = makeCtx({ usage: { tokens: 800_000, contextWindow: 1_000_000 } });
	pi.fireToolCall(h.ctx);
	assert.match(h.statuses.at(-1)!, /context 80% . pi compacts at 98% between tool batches/);
	assert.equal(h.compacts.length, 0, "ctx.compact() aborts the run; never called here");
});

test("tool_call past pi's trigger reports a compaction after this batch", () => {
	const pi = install(makePi());
	const h = makeCtx({ usage: { tokens: 990_000, contextWindow: 1_000_000 } });
	pi.fireToolCall(h.ctx, "read");
	assert.match(h.statuses.at(-1)!, /context 99% . compacting after this tool batch/);
	assert.equal(h.compacts.length, 0);
	// Repeated identical checks must not re-write the status line.
	const before = h.statuses.length;
	pi.fireToolCall(h.ctx, "read");
	assert.equal(h.statuses.length, before, "status writes are deduplicated");
});

test("tool_call without a model falls back to a generic pressure line", () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		model: undefined,
	});
	pi.fireToolCall(h.ctx);
	assert.match(h.statuses.at(-1)!, /context 90% . pi compacts at \?%/);
});

// --- pi threshold alignment ----------------------------------------------------

test("align on writes a per-model reserve so pi compacts mid-run at our threshold", async () => {
	writeConfig({ threshold: 78 });
	writePiSettings({ theme: "dark", compaction: { enabled: true } });
	try {
		const pi = install(makePi());
		const h = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("align on", h.ctx);
		assert.match(h.notifies.at(-1)!.text, /follows 78%/);
		assert.match(h.notifies.at(-1)!.text, /run \/reload to apply/);

		const settings = readPiSettings();
		assert.deepEqual(settings.compaction, {
			enabled: true,
			modelOverrides: { "deepseek/deepseek-flash": { reserveTokens: 220_000 } },
		});
		assert.equal(settings.theme, "dark", "unrelated settings survive");

		// pi now compacts at contextWindow - reserveTokens = 78%.
		const ctx = makeCtx({ usage: { tokens: 800_000, contextWindow: 1_000_000 } });
		pi.fireToolCall(ctx.ctx);
		assert.match(ctx.statuses.at(-1)!, /context 80% . compacting after this tool batch/);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("a model switch re-aligns the new model", () => {
	writeConfig({ threshold: 78, alignPiThreshold: true });
	rmSync(SETTINGS_FILE, { force: true });
	try {
		const pi = install(makePi());
		const h = makeCtx({ usage: undefined });
		pi.fireModelSelect(h.ctx);
		assert.equal(
			readPiSettings().compaction.modelOverrides["deepseek/deepseek-flash"]
				.reserveTokens,
			220_000,
		);
		assert.match(h.notifies.at(-1)!.text, /aligned to 78%.*run \/reload to apply/);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("align on never overwrites a reserve the user configured", async () => {
	writeConfig({ threshold: 78, alignPiThreshold: true });
	writePiSettings({ compaction: { reserveTokens: 400_000 } });
	try {
		const pi = install(makePi());
		const h = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("align on", h.ctx);
		assert.equal(h.notifies.at(-1)!.kind, "warning");
		assert.match(h.notifies.at(-1)!.text, /already has a compaction budget/);
		assert.equal(
			readPiSettings().compaction.reserveTokens,
			400_000,
			"the user's global reserve is untouched",
		);
		assert.ok(
			!readPiSettings().compaction.modelOverrides,
			"no per-model override is written either",
		);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("align off removes only the reserve this extension wrote", async () => {
	writeConfig({
		threshold: 78,
		alignPiThreshold: true,
		alignedReserveTokens: { "deepseek/deepseek-flash": 220_000 },
	});
	writePiSettings({
		compaction: {
			keepRecentTokens: 20_000,
			modelOverrides: {
				"deepseek/deepseek-flash": { reserveTokens: 220_000 },
				"xai/grok-4.7": { reserveTokens: 5_000 },
			},
		},
	});
	try {
		const pi = install(makePi());
		pi.fireSessionStart(makeCtx({ usage: undefined }).ctx);

		const h = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("align off", h.ctx);
		assert.match(h.notifies.at(-1)!.text, /back to pi's own threshold/);
		const compaction = readPiSettings().compaction;
		assert.deepEqual(compaction.keepRecentTokens, 20_000);
		assert.deepEqual(compaction.modelOverrides, {
			"xai/grok-4.7": { reserveTokens: 5_000 },
		});
		assert.equal(
			JSON.parse(readFileSync(CONFIG_FILE, "utf8")).alignedReserveTokens?.["deepseek/deepseek-flash"],
			undefined,
			"the bookkeeping entry is dropped too",
		);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("a reserve the user changed stops being managed", async () => {
	writeConfig({
		threshold: 78,
		alignPiThreshold: true,
		alignedReserveTokens: { "deepseek/deepseek-flash": 220_000 },
	});
	writePiSettings({
		compaction: { modelOverrides: { "deepseek/deepseek-flash": { reserveTokens: 300_000 } } },
	});
	try {
		const pi = install(makePi());
		pi.fireSessionStart(makeCtx({ usage: undefined }).ctx);
		assert.equal(
			readPiSettings().compaction.modelOverrides["deepseek/deepseek-flash"].reserveTokens,
			300_000,
			"the user's value wins",
		);
		assert.deepEqual(
			JSON.parse(readFileSync(CONFIG_FILE, "utf8")).alignedReserveTokens,
			{},
			"and it is no longer ours to remove",
		);
	} finally {
		writeConfig({ threshold: 78 });
		rmSync(SETTINGS_FILE, { force: true });
	}
});

test("reset clears the threshold and the managed reserve", async () => {
	writeConfig({
		threshold: 40,
		alignPiThreshold: true,
		alignedReserveTokens: { "deepseek/deepseek-flash": 600_000 },
	});
	writePiSettings({ compaction: { modelOverrides: { "deepseek/deepseek-flash": { reserveTokens: 600_000 } } } });
	const pi = install(makePi());
	const h = makeCtx({ usage: undefined });
	pi.fireSessionStart(h.ctx);
	assert.equal(
		readPiSettings().compaction.modelOverrides["deepseek/deepseek-flash"].reserveTokens,
		600_000,
	);
	await pi.command("compact-threshold").handler("reset", h.ctx);
	assert.ok(!existsSync(CONFIG_FILE), "config file removed");
	assert.equal(readPiSettings().compaction, undefined, "pi's compaction block is cleaned up");
	rmSync(SETTINGS_FILE, { force: true });
});

test("/compact-threshold hot-reloads the config written by another session", async () => {
	writeConfig({ threshold: 78 });
	rmSync(SETTINGS_FILE, { force: true });
	try {
		const pi = install(makePi()); // loads 78%
		writeConfig({ threshold: 50, alignPiThreshold: true }); // another session changed it
		const h = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("", h.ctx);
		const text = h.notifies.at(-1)!.text;
		assert.match(text, /Auto-compaction threshold: 50%/);
		assert.ok(
			!/align on to compact mid-run/.test(text),
			"the hint disappears once alignment is on elsewhere",
		);
	} finally {
		writeConfig({ threshold: 78 });
	}
});

test("/compact-threshold without arguments reports both thresholds", async () => {
	writeConfig({ threshold: 78 });
	rmSync(SETTINGS_FILE, { force: true });
	try {
		const pi = install(makePi());
		const h = makeCtx({ usage: undefined });
		await pi.command("compact-threshold").handler("", h.ctx);
		const text = h.notifies.at(-1)!.text;
		assert.match(text, /Auto-compaction threshold: 78%/);
		assert.match(text, /Pi compacts mid-run at 98% \(reserveTokens 16384, pi default\)/);
		assert.match(text, /align on to compact mid-run at 78%/);

		await pi.command("compact-threshold").handler("align", h.ctx);
		assert.match(h.notifies.at(-1)!.text, /Usage: \/compact-threshold align on\|off/);
	} finally {
		writeConfig({ threshold: 78 });
	}
});
