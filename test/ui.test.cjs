"use strict";
// Run: node --test test/ui.test.cjs   (needs devDependencies: jiti, @earendil-works/pi-tui, @earendil-works/pi-coding-agent)
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename, { interopDefault: true });
const strip = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, "");
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// Minimal theme stand-in (the component only uses fg/bg/bold).
const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t, strikethrough: (t) => t };

let ui, visibleWidth;

before(async () => {
	const cc = await jiti.import("@earendil-works/pi-coding-agent");
	cc.initTheme("dark"); // global markdown theme used by the transcript renderer
	({ visibleWidth } = await jiti.import("@earendil-works/pi-tui"));
	ui = await jiti.import(path.join(__dirname, "..", "src", "ui.ts"));
});

function setup(storeInit = {}) {
	const { WatcherStore, WatcherOverlay } = ui;
	const store = new WatcherStore({ model: { provider: "p", id: "m1" }, ...storeInit });
	const tui = { terminal: { rows: 30, columns: 100 }, renders: 0, requestRender() { this.renders++; } };
	const calls = [];
	const controller = {
		submit: async (t) => void calls.push(["submit", t]),
		stop: async () => void calls.push(["stop"]),
		setModel: async (m) => void calls.push(["setModel", m.id]),
		listModels: () => [{ provider: "p", id: "m1" }, { provider: "p", id: "m2", name: "Model 2" }, { provider: "q", id: "x/y" }],
		onClose: () => calls.push(["onClose"]),
	};
	const ctx = { ui: { theme, notify() {} }, mode: "tui", hasUI: true, modelRegistry: { getAvailable: () => [] } };
	const env = { store, tui, calls, controller, ctx, result: undefined };
	env.mk = (extra = {}) => {
		env.result = undefined;
		const o = new WatcherOverlay(tui, theme, ctx, { store, controller, ...extra }, (r) => (env.result = r));
		o.focused = true;
		return o;
	};
	env.text = (o, w = 70) => strip(o.render(w).join("\n"));
	env.cmd = (o, c) => { o.handleInput("\x15"); for (const ch of c) o.handleInput(ch); o.handleInput("\r"); };
	return env;
}

test("store normalizes messages and drops unknown roles", () => {
	const { store } = setup({ messages: [{ role: "user", text: "a" }, { role: "bogus", text: "x" }, { role: "assistant", text: 5 }] });
	assert.deepEqual(store.state.messages.map((m) => [m.role, m.text]), [["user", "a"], ["assistant", "5"]]);
});

test("renders within width/height for many sizes, with markdown/tool messages", () => {
	const e = setup({ messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "# Hi\n**md**\n```ts\nconst a = 1\n```" }, { role: "tool", text: "bash\n1\n2\n3\n4\n5\n6" }] });
	const o = e.mk();
	for (const rows of [5, 8, 12, 30, 60]) {
		e.tui.terminal.rows = rows;
		for (const w of [12, 20, 40, 52, 80, 120]) {
			const lines = o.render(w);
			assert.ok(lines.length <= Math.max(4, rows - 2), `height rows=${rows} w=${w}`);
			lines.forEach((l, i) => assert.ok(visibleWidth(l) <= w, `rows=${rows} w=${w} line ${i}`));
		}
	}
	e.tui.terminal.rows = 30;
	assert.match(e.text(o), /more line/);
	assert.ok(o.render(70).join("\n").includes("\x1b_pi:c\x07"), "cursor marker survives framing");
});

test("opens idle without prompting; submit, busy refusal keeps draft, close persists draft", async () => {
	const e = setup();
	const o = e.mk();
	assert.equal(e.calls.length, 0);
	for (const ch of "ask me") o.handleInput(ch);
	assert.equal(e.store.state.draft, "ask me");
	o.handleInput("\r");
	await tick();
	assert.deepEqual(e.calls.at(-1), ["submit", "ask me"]);
	assert.equal(e.store.state.side.status, "running");
	assert.equal(e.store.state.draft, "");
	for (const ch of "again") o.handleInput(ch);
	o.handleInput("\r");
	assert.equal(e.store.state.draft, "again");
	assert.match(e.text(o), /busy/);
	for (let i = 0; i < 50; i++) e.store.appendLive("word ");
	assert.match(e.text(o), /word/);
	o.handleInput("\x1b"); // Esc closes UI only
	assert.equal(e.result.reason, "closed");
	assert.ok(!e.calls.some((c) => c[0] === "stop"), "Esc must not stop anything");
	const o2 = e.mk();
	assert.match(e.text(o2), /again/); // draft restored
});

test("no model -> submit refused", () => {
	const e = setup();
	e.store.setModel(undefined);
	const o = e.mk();
	for (const ch of "hi") o.handleInput(ch);
	o.handleInput("\r");
	assert.equal(e.calls.length, 0);
	assert.match(e.text(o), /No side model/);
});

test("/stop cancels side only; /model refused while running; picker selects model", async () => {
	const e = setup();
	const o = e.mk();
	e.store.beginTurn("q");
	e.cmd(o, "/model");
	assert.match(e.text(o), /Cannot change/);
	e.cmd(o, "/stop");
	assert.deepEqual(e.calls.at(-1), ["stop"]);
	assert.equal(e.store.state.side.status, "stopping");
	e.store.appendLive("partial");
	e.store.endTurn({ aborted: true });
	assert.equal(e.store.state.side.status, "idle");
	e.cmd(o, "/model");
	await tick();
	let t = e.text(o);
	assert.ok(t.includes("Select side model") && t.includes("p/m2"));
	o.handleInput("m"); o.handleInput("2");
	t = e.text(o);
	assert.ok(t.includes("p/m2") && !t.includes("q/x/y"));
	o.handleInput("\r");
	await tick();
	assert.deepEqual(e.calls.at(-1), ["setModel", "m2"]);
	assert.equal(e.store.state.model.id, "m2");
	// Esc in picker goes back, does not close
	e.cmd(o, "/model");
	await tick();
	o.handleInput("\x1b");
	assert.equal(e.result, undefined);
	assert.ok(!e.text(o).includes("Select side model"));
});

test("setModel rejection leaves model unchanged", async () => {
	const e = setup();
	e.controller.setModel = async () => { throw new Error("nope"); };
	const o = e.mk({ initialAction: "model" });
	await tick();
	o.handleInput("m"); o.handleInput("2"); o.handleInput("\r");
	await tick();
	assert.equal(e.store.state.model.id, "m1");
	assert.match(e.text(o), /Model change failed: nope/);
});

test("initialAction 'model' opens picker without sending a prompt", async () => {
	const e = setup();
	const o = e.mk({ initialAction: "model" });
	await tick();
	assert.ok(e.text(o).includes("Select side model"));
	assert.equal(e.calls.length, 0);
	assert.equal(e.store.state.messages.length, 0);
});

test("steering approval: s only selects, Edit sends edited text, Cancel cancels, Esc keeps pending", async () => {
	const e = setup();
	const o = e.mk();
	const p = e.store.requestSteeringApproval({ text: "Run tests", reason: "missing" });
	assert.match(e.text(o), /Steer main agent\?[\s\S]*Send/);
	let decided = false;
	p.then(() => (decided = true));
	o.handleInput("s");
	await tick();
	assert.equal(decided, false, "s must not confirm");
	o.handleInput("e");
	o.handleInput("\r"); // enter edit mode
	assert.match(e.text(o), /Edit steering message/);
	o.handleInput("!");
	o.handleInput("\r");
	assert.deepEqual(await p, { action: "send", text: "Run tests!", edited: true });
	assert.equal(e.store.state.approvals.length, 0);

	const p2 = e.store.requestSteeringApproval({ text: "x" });
	o.handleInput("\x1b");
	assert.equal(e.result.reason, "closed");
	assert.equal(e.store.state.approvals.length, 1, "stays pending after close");
	const o2 = e.mk();
	o2.handleInput("c"); o2.handleInput("\r");
	assert.deepEqual(await p2, { action: "cancel" });

	// Send unedited
	const o3 = e.mk();
	const p3 = e.store.requestSteeringApproval({ text: "go" });
	o3.handleInput("s"); o3.handleInput("\r");
	assert.deepEqual(await p3, { action: "send", text: "go", edited: false });
});

test("approval cancel via signal / dispose resolves cancel", async () => {
	const { WatcherStore } = ui;
	const s = new WatcherStore();
	const ac = new AbortController();
	const p = s.requestSteeringApproval({ text: "a" }, ac.signal);
	ac.abort();
	assert.deepEqual(await p, { action: "cancel" });
	const p2 = s.requestSteeringApproval({ text: "b" });
	s.dispose();
	assert.deepEqual(await p2, { action: "cancel" });
});

test("scroll: follow, page up pins view, wheel, page down re-follows; render is capped and fast", () => {
	const e = setup({ messages: Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `line ${i} ${"lorem ipsum ".repeat(10)}` })) });
	const o = e.mk();
	const t0 = Date.now();
	o.render(80);
	assert.ok(Date.now() - t0 < 1000);
	assert.ok(e.store.state.view.follow);
	o.handleInput("\x1b[5~");
	assert.ok(!e.store.state.view.follow && e.store.state.view.top > 0);
	const top = e.store.state.view.top;
	e.store.addMessage("assistant", "new");
	o.render(80);
	assert.equal(e.store.state.view.top, top, "view anchored when new content arrives");
	o.handleMouse({ type: "wheel", wheelDelta: 3 });
	assert.ok(e.store.state.view.top > top);
	for (let i = 0; i < 200; i++) o.handleInput("\x1b[6~");
	assert.ok(e.store.state.view.follow);
});

test("live streaming is capped and cheap", () => {
	const e = setup();
	const o = e.mk();
	const t0 = Date.now();
	for (let i = 0; i < 40; i++) { e.store.appendLive("streaming 日本語 🚀 ".repeat(100)); o.render(70); }
	assert.ok(e.store.state.live.truncated && e.store.state.live.text.length <= 20000);
	assert.ok(Date.now() - t0 < 3000);
});

test("dispose unsubscribes and is idempotent", () => {
	const e = setup();
	const o = e.mk();
	const before = e.tui.renders;
	e.store.setMain({ status: "running" });
	assert.ok(e.tui.renders > before);
	o.dispose(); o.dispose();
	const after = e.tui.renders;
	e.store.setMain({ status: "idle" });
	assert.equal(e.tui.renders, after);
});

test("openWatcherUI: open flag, already-open, unsupported, signal, initialAction, onClose", async () => {
	const e = setup();
	let comp;
	const ctx2 = { ...e.ctx, ui: { ...e.ctx.ui, custom: (f) => new Promise((res) => { comp = f(e.tui, theme, {}, res); }) } };
	const pr = ui.openWatcherUI(ctx2, { store: e.store, controller: e.controller, initialAction: "model" });
	assert.equal(e.store.state.open, true);
	await tick();
	assert.ok(strip(comp.render(70).join("\n")).includes("Select side model"));
	assert.equal((await ui.openWatcherUI(ctx2, { store: e.store, controller: e.controller })).reason, "already-open");
	comp.handleInput("\x1b"); // back from picker
	comp.handleInput("\x1b"); // close
	assert.equal((await pr).reason, "closed");
	assert.equal(e.store.state.open, false);
	assert.equal(e.calls.at(-1)[0], "onClose");
	assert.equal((await ui.openWatcherUI({ ...e.ctx, mode: "rpc" }, { store: e.store, controller: e.controller })).reason, "unsupported");
	const ac = new AbortController();
	const pr2 = ui.openWatcherUI(ctx2, { store: e.store, controller: e.controller, signal: ac.signal });
	ac.abort();
	assert.equal((await pr2).reason, "aborted");
	assert.equal(e.store.state.open, false);
});
