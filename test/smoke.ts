/**
 * Mock smoke test for extensions/auto-compact.ts.
 *
 * Runs with plain Node (>=22.18 / >=23.6 native TS type stripping):
 *   npm test
 *
 * Mocks the ExtensionAPI surface (events, commands, ctx.ui, ctx.compact) and
 * covers: threshold math, soft/abort/timeout fail-open, hard-fail editor
 * restore, concurrent-prompt serialization, session-switch guarding, and
 * config persistence/hot reload. The real pi SDK is imported for
 * estimateTokens/getAgentDir; no agent state is touched because
 * PI_CODING_AGENT_DIR points at a throwaway temp dir set before the
 * extension module resolves CONFIG_FILE.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-auto-compact-smoke-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const CONFIG_FILE = join(agentDir, "pi-auto-compact.json");

const { default: createExtension } = await import("../extensions/auto-compact.ts");

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
		registerCommand(name: string, def: { description: string; handler: Handler }) {
			commands.set(name, def);
		},
	};
	return { pi, events, commands };
}

function install(pi: MockPi) {
	createExtension(pi.pi);
	return {
		fireInput: (event: any, ctx: any) => pi.events.get("input")![0]!({ source: "interactive", ...event }, ctx),
		fireTurnEnd: (ctx: any) => pi.events.get("turn_end")!.map((h) => h({}, ctx)),
		fireSessionStart: (ctx: any) => pi.events.get("session_start")!.map((h) => h({}, ctx)),
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
}): CtxHarness {
	const compacts: CompactHandler[] = [];
	const harness: CtxHarness = {
		ctx: {
			hasUI: true,
			mode: "tui",
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
				editorText: "",
				getEditorText() {
					return (harness.ctx.ui as any).editorText;
				},
				setEditorText(text: string) {
					(harness.ctx.ui as any).editorText = text;
				},
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

const tests: { name: string; fn: () => Promise<void> | void }[] = [];
function test(name: string, fn: () => Promise<void> | void) {
	tests.push({ name, fn });
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
	assert.equal((await pi.fireInput({ text: "hi" }, noUsage.ctx)).action, "continue");
	assert.equal(noUsage.compacts.length, 0);

	const nullTokens = makeCtx({ usage: { tokens: null, contextWindow: 100 } });
	assert.equal((await pi.fireInput({ text: "hi" }, nullTokens.ctx)).action, "continue");

	const queued = makeCtx({ usage: { tokens: 99, contextWindow: 100 } });
	const res = await pi.fireInput({ text: "hi", streamingBehavior: "steer" }, queued.ctx);
	assert.equal(res.action, "continue");
	assert.equal(queued.compacts.length, 0);
});

test("projected over threshold: compact once, then send", async () => {
	const pi = install(makePi());
	const h = makeCtx({ usage: { tokens: 90, contextWindow: 100 }, onCompact: (c) => c.onComplete?.({}) });
	const res = await pi.fireInput({ text: "a long prompt goes here" }, h.ctx);
	assert.equal(res.action, "continue");
	assert.equal(h.compacts.length, 1);
	assert.match(h.statuses[0]!, /projected/);
	assert.equal(h.statuses.at(-1), undefined, "status cleared after success");
});

// --- failure classification --------------------------------------------------

test("soft errors fail open without an error status", async () => {
	for (const message of ["Nothing to compact (session too small)", "Already compacted"]) {
		const pi = install(makePi());
		const h = makeCtx({ usage: { tokens: 90, contextWindow: 100 }, onCompact: (c) => c.onError?.(new Error(message)) });
		const res = await pi.fireInput({ text: "hi" }, h.ctx);
		assert.equal(res.action, "continue", message);
		assert.equal(h.notifies.at(-1)?.kind, "warning", message);
		assert.match(h.notifies.at(-1)!.text, /Sending prompt anyway/, message);
		assert.ok(!h.statuses.includes("compact failed"), message);
	}
});

test("aborted compaction fails open", async () => {
	const pi = install(makePi());
	const error = new Error("Compaction cancelled");
	error.name = "AbortError";
	const h = makeCtx({ usage: { tokens: 90, contextWindow: 100 }, onCompact: (c) => c.onError?.(error) });
	const res = await pi.fireInput({ text: "hi" }, h.ctx);
	assert.equal(res.action, "continue");
	assert.match(h.notifies.at(-1)!.text, /Sending prompt anyway/);
});

test("hard error: prompt not sent, text restored to empty editor", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: (c) => c.onError?.(new Error("provider exploded")),
	});
	const res = await pi.fireInput({ text: "important long prompt" }, h.ctx);
	assert.equal(res.action, "handled");
	assert.equal(h.ctx.ui.editorText, "important long prompt");
	assert.equal(h.notifies.at(-1)?.kind, "error");
	assert.match(h.notifies.at(-1)!.text, /text restored to the editor/);
});

test("hard error with occupied editor: never clobbers new input", async () => {
	const pi = install(makePi());
	const h = makeCtx({
		usage: { tokens: 90, contextWindow: 100 },
		onCompact: (c) => c.onError?.(new Error("provider exploded")),
	});
	h.ctx.ui.editorText = "freshly typed message";
	const res = await pi.fireInput({ text: "old prompt" }, h.ctx);
	assert.equal(res.action, "handled");
	assert.equal(h.ctx.ui.editorText, "freshly typed message");
	assert.match(h.notifies.at(-1)!.text, /resubmit when ready/);
});

test("stalled compaction times out and later preflights keep working", async () => {
	writeConfig({ threshold: 78, compactTimeoutMs: 1000 });
	const pi = install(makePi());
	const stalled = makeCtx({ usage: { tokens: 90, contextWindow: 100 }, onCompact: () => undefined });
	const res = await pi.fireInput({ text: "hi" }, stalled.ctx);
	assert.equal(res.action, "continue");
	assert.match(stalled.notifies.at(-1)!.text, /did not settle within 1s/);
	assert.match(stalled.notifies.at(-1)!.text, /Sending prompt anyway/);

	// Deadlock guard: the stalled in-flight promise must not block the next prompt.
	const next = makeCtx({ usage: { tokens: 90, contextWindow: 100 }, onCompact: (c) => c.onComplete?.({}) });
	assert.equal((await pi.fireInput({ text: "hi" }, next.ctx)).action, "continue");
	assert.equal(next.compacts.length, 1);
});

// --- concurrency / session guarding -------------------------------------------

test("two prompts racing past the guard share one compaction", async () => {
	const pi = install(makePi());
	const h = makeCtx({ usage: { tokens: 90, contextWindow: 100 }, onCompact: () => undefined });
	const p1 = pi.fireInput({ text: "first" }, h.ctx);
	const p2 = pi.fireInput({ text: "second" }, h.ctx);
	h.compacts[0]!.onComplete?.({});
	assert.equal((await p1).action, "continue");
	assert.equal((await p2).action, "continue");
	assert.equal(h.compacts.length, 1);
});

test("session switch mid-compaction: stale callbacks never touch UI", async () => {
	const pi = install(makePi());
	const h = makeCtx({ usage: { tokens: 90, contextWindow: 100 }, onCompact: () => undefined });
	const pending = pi.fireInput({ text: "hi" }, h.ctx);
	pi.fireSessionStart(makeCtx({ usage: undefined }).ctx); // bumps generation, resets inFlight
	h.compacts[0]!.onComplete?.({});
	assert.equal((await pending).action, "continue");
	assert.equal(h.statuses.length, 1, "only the pre-compaction status was written");
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
	const hot = makeCtx({ usage: { tokens: 90, contextWindow: 100 }, onCompact: (c) => c.onComplete?.({}) });
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
	assert.equal(h.notifies.at(-1)!.text, "Auto-compaction threshold: 78%");

	await cmd.handler("62", h.ctx);
	const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	assert.equal(saved.threshold, 62);
	assert.equal(saved.compactTimeoutMs, 5000, "unknown config keys survive a save");

	for (const bad of ["0", "20", "abc", "99", "100", "-5"]) {
		const before = readFileSync(CONFIG_FILE, "utf8");
		await cmd.handler(bad, h.ctx);
		assert.equal(h.notifies.at(-1)!.kind, "warning", bad);
		assert.equal(readFileSync(CONFIG_FILE, "utf8"), before, `${bad} must not touch the file`);
	}

	await cmd.handler("reset", h.ctx);
	assert.ok(!existsSync(CONFIG_FILE), "reset removes the config file");
});

// --- runner ---------------------------------------------------------------------

let failures = 0;
for (const { name, fn } of tests) {
	try {
		await fn();
		console.log(`ok    ${name}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL  ${name}`);
		console.error(`      ${error instanceof Error ? error.message : String(error)}`);
	}
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures === 0 ? 0 : 1);
