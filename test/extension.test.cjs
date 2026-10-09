const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createJiti } = require("jiti");
const jiti = createJiti(__filename);
const tick = () => new Promise(r => setTimeout(r, 20));
async function until(fn) { const deadline = Date.now() + 20000; while (!fn()) { if (Date.now() > deadline) throw Error("Timed out"); await tick(); } }

test("/watcher opens before slow startup; integrates questions, history, models, live tools and approved steering", { timeout: 90000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "watcher-extension-"));
  const agent = join(root, "agent"); const cwd = join(root, "project");
  mkdirSync(agent); mkdirSync(cwd);
  // Put the inherited provider outside the watcher package, which is deliberately excluded.
  cpSync(join(__dirname, "fixtures/runtime/extensions/faux-provider.ts"), join(agent, "faux.ts"));
  const gate = join(root, "startup-release");
  const slowExtension = join(agent, "slow.ts");
  writeFileSync(slowExtension, `import { existsSync } from "node:fs";
    export default function(pi) { pi.on("session_start", async () => {
      const deadline = Date.now() + 20000;
      while (!existsSync(${JSON.stringify(gate)})) {
        if (Date.now() > deadline) throw new Error("Startup gate timed out");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }); }`);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", extensions: [join(agent, "faux.ts"), slowExtension] }));
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const main = join(cwd, "main.jsonl");
  writeFileSync(main, JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() }) + "\n");
  const oldEnv = { ...process.env };
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", FIXTURE_MAIN_FILE: main });
  const handlers = new Map(); const commands = new Map(); const shortcuts = new Map(); const sent = []; const notifications = [];
  const pi = {
    on: (name, fn) => { handlers.set(name, fn); return () => {}; },
    registerCommand: (name, cmd) => commands.set(name, cmd),
    registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
    sendUserMessage: (text, opts) => sent.push({ text, opts }),
  };
  const theme = { fg: (_c,t)=>t, bg: (_c,t)=>t, bold:t=>t, italic:t=>t, underline:t=>t, inverse:t=>t, strikethrough:t=>t };
  let overlay; let store; let abortedMain = false; const statusCalls = [];
  const ctx = {
    mode: "tui", hasUI: true, cwd, isIdle: () => false, isProjectTrusted: () => false,
    abort: () => { abortedMain = true; },
    sessionManager: { getSessionId: () => id, getSessionFile: () => main, getLeafId: () => "leaf-1" },
    modelRegistry: { getAvailable: () => [] },
    ui: {
      setStatus(key, text) { statusCalls.push({ key, text }); }, notify: (text) => notifications.push(text),
      custom: (factory) => new Promise(resolve => {
        const component = factory({ terminal: { rows: 35, columns: 140 }, requestRender() {} }, theme, {}, result => {
          component.dispose(); if (overlay === component) overlay = undefined; resolve(result);
        });
        overlay = component; store = component.store; component.focused = true;
      }),
    },
  };
  try {
    (await jiti.import("@earendil-works/pi-coding-agent")).initTheme("dark");
    const extension = (await jiti.import(join(__dirname, "../src/index.ts"))).default;
    extension(pi);
    assert.deepEqual([...commands.keys()], ["watcher"]);
    await handlers.get("session_start")({}, ctx);
    const cmd = commands.get("watcher").handler;
    const openedAt = performance.now();
    assert.deepEqual([...shortcuts.keys()], ["alt+w"]);
    const toggle = shortcuts.get("alt+w").handler;
    await toggle({ ...ctx, mode: "rpc" });
    assert.equal(overlay, undefined);
    const first = toggle(ctx);
    await until(() => overlay);
    t.diagnostic(`Cold overlay visible after ${Math.round(performance.now() - openedAt)} ms (child initialization still blocked)`);
    assert.equal(store.state.side.status, "starting", "panel must not await inherited extension initialization");
    assert.equal(store.state.messages.length, 0, "bare /watcher must never prompt");
    for (const ch of "cancel me") overlay.handleInput(ch);
    overlay.handleInput("\r");
    assert.equal(store.state.side.status, "running", "questions can be submitted before a model is loaded");
    for (const ch of "/stop") overlay.handleInput(ch);
    overlay.handleInput("\r");
    await until(() => store.state.side.status === "starting");
    overlay.handleInput("\x1bw"); await first;
    assert.equal(abortedMain, false);

    const ask = cmd("hello", ctx);
    await until(() => overlay);
    assert.equal(store.state.model, undefined, "question is queued, not sent, before startup completes");
    writeFileSync(gate, "ready");
    await until(() => overlay && store.state.side.status === "idle" && store.state.messages.some(m => m.text === "echo: hello"));
    assert.ok(!store.state.messages.some(m => m.text.includes("cancel me")), "cancelled startup question must never be sent");
    assert.equal(store.state.messages.filter(m => m.role === "user").length, 1);
    overlay.handleInput("\x1b"); await ask;
    assert.deepEqual(statusCalls, [], "Watcher must never touch the status bar");
    const savedStore = store;
    const again = toggle(ctx); await until(() => overlay);
    assert.equal(store, savedStore, "toggle must reuse the side conversation");
    assert.ok(store.state.messages.some(m => m.text === "echo: hello"));
    assert.equal(store.state.messages.filter(m => m.role === "user").length, 1);
    await toggle(ctx); await again;
    assert.equal(overlay, undefined);

    const choose = cmd("model", ctx); await until(() => overlay && overlay.mode === "model");
    assert.equal(store.state.messages.filter(m => m.role === "user").length, 1, "model picker is not a prompt");
    overlay.handleInput("\x1b"); overlay.handleInput("\x1b"); await choose;

    handlers.get("tool_execution_start")({ toolCallId: "running", toolName: "bash", args: { command: "sleep 10" } }, ctx);
    const live = cmd("LIVE", ctx);
    await until(() => overlay && store.state.side.status === "idle" && store.state.messages.some(m => m.text.includes('"name":"bash"')));
    handlers.get("tool_execution_end")({ toolCallId: "running" }, ctx);
    overlay.handleInput("\x1b"); await live;

    const steer = cmd("STEER", ctx);
    await until(() => overlay && store.state.approvals.length === 1);
    assert.equal(sent.length, 0, "approval required");
    // The side agent is still executing steer_main, awaiting approval. Switch its
    // model through the actual command/controller/RPC path without cancelling it.
    overlay.handleInput("\x1b"); await steer;
    const switchRunning = cmd("model", ctx);
    await until(() => overlay && overlay.mode === "model" && !overlay.pickerLoading);
    for (const ch of "faux-2") overlay.handleInput(ch);
    overlay.handleInput("\r");
    await until(() => store.state.model?.id === "faux-2");
    assert.equal(store.state.side.status, "running");
    assert.equal(store.state.approvals.length, 1);
    assert.equal(sent.length, 0);
    const approval = store.state.approvals[0];
    store.resolveApproval(approval.id, { action: "send", text: "inspect logs first", edited: true });
    await until(() => sent.length === 1 && store.state.side.status === "idle");
    assert.match(sent[0].text, /\[Watcher — approved by you\] inspect logs first/);
    assert.deepEqual(sent[0].opts, { deliverAs: "steer" });
    overlay.handleInput("\x1b"); await switchRunning;
    assert.equal(abortedMain, false);
    assert.ok(!notifications.some(n => /Watcher: .*Error/.test(n)), notifications.join("\n"));
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(statusCalls, [], "Watcher must not touch the status bar, including during shutdown");
  }
});
