import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WatcherRuntime } from "../../src/runtime.ts";

// Runs inside the global Pi, after its main conversation is persisted.
export default function evergreenProbe(pi: ExtensionAPI): void {
  pi.on("agent_settled", async (_event, ctx) => {
    const report = process.env.EVERGREEN_REPORT;
    if (!report) throw new Error("EVERGREEN_REPORT is required");
    const rt = new WatcherRuntime();
    try {
      const main = ctx.sessionManager.getSessionFile();
      assert.ok(main);
      assert.ok(ctx.model);
      const before = readFileSync(main, "utf8");
      const options = {
        cwd: ctx.cwd, mainSessionFile: main,
        mainSessionId: ctx.sessionManager.getSessionId(),
        sessionDir: join(ctx.cwd, "side-sessions"),
        inheritCliArgs: false,
        model: { provider: ctx.model.provider, modelId: ctx.model.id },
        extraArgs: ["--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--tools", "read,live_main_tools"],
        liveMainTools: () => JSON.stringify({ marker: "EVERGREEN_LIVE", state: "idle" }),
      };
      const info = await rt.start(options);
      assert.notEqual(info.sideSessionFile, main);
      assert.equal((await rt.getMessages()).length, 0, "opening must not prompt");
      const reply = await rt.promptAndWait(
        "Read the authoritative main session file named in your system prompt with read, and call live_main_tools. " +
        "Reply with the EVERGREEN_MAIN_ token from the main user's message and the live marker. " +
        "Do not inspect source, run checks, or send steering.",
        { timeoutMs: 120_000 },
      );
      assert.match(reply.text ?? "", /EVERGREEN_MAIN_7c91/);
      assert.match(reply.text ?? "", /EVERGREEN_LIVE/);
      const messages = await rt.getMessages();
      assert.ok(messages.some(m => m.role === "toolResult" && m.toolName === "read"));
      assert.ok(messages.some(m => m.role === "toolResult" && m.toolName === "live_main_tools"));
      assert.equal(readFileSync(main, "utf8"), before, "observation must leave main history unchanged");
      await rt.dispose();
      const resumed = await WatcherRuntime.start(options);
      try {
        assert.equal(resumed.info?.sideSessionFile, info.sideSessionFile);
        assert.deepEqual(await resumed.getMessages(), messages, "restart restores the conversation without prompting");
      } finally { await resumed.dispose(); }
      writeFileSync(report, JSON.stringify({ ok: true, model: options.model, sideSessionFile: info.sideSessionFile }));
    } catch (error) {
      writeFileSync(report, JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) }));
    } finally { await rt.dispose(); }
  });
}
