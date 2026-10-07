import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWatcherSystemPrompt } from "../src/runtime-prompt.ts";

test("Watcher prompt distinguishes the authoritative main transcript from its own session", () => {
  const main = '/sessions/main "quoted".jsonl';
  const side = "/watcher-sessions/side.jsonl";
  const prompt = buildWatcherSystemPrompt({
    mainSessionFile: main, mainSessionId: "main-id",
    sideSessionFile: side, sideSessionId: "watcher-id", cwd: "/project",
    capabilities: { liveMainTools: true, steerMain: true },
  });
  assert.ok(prompt.includes(`MAIN agent transcript to inspect: ${JSON.stringify(main)}`));
  assert.ok(prompt.includes(`YOUR Watcher conversation (not the main transcript): ${JSON.stringify(side)}`));
  assert.ok(prompt.includes("MAIN agent session id: main-id"));
  assert.ok(prompt.includes("YOUR Watcher session id: watcher-id"));
  assert.ok(prompt.includes("PI_SESSION_FILE and PI_SESSION_ID"));
  assert.ok(prompt.includes("YOUR Watcher session, NOT the MAIN agent"));
  assert.ok(prompt.includes(`read ${JSON.stringify(main)} directly with the read tool`));
  assert.ok(prompt.includes("Do not inspect your own transcript, list session directories"));
  assert.ok(prompt.includes("If the supplied main file is unavailable, report that"));
});
