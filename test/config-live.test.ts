import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSettings } from "../src/config.ts";
import { LiveTools, MAX_LIVE_TOOLS } from "../src/live-tools.ts";

test("settings are created independently and validate exclusions/model", () => {
  const dir = mkdtempSync(join(tmpdir(), "watcher-config-"));
  try {
    const settings = loadSettings(dir);
    assert.deepEqual(settings.excludedExtensions, []);
    assert.equal(settings.sessionDir, join(dir, "pi-watcher-sessions"));
    const file = join(dir, "pi-watcher.json");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { excludedExtensions: [] });
    writeFileSync(file, JSON.stringify({ excludedExtensions: ["./extensions/no.ts", "npm:example"], model: { provider: "p", modelId: "m" }, thinkingLevel: "low" }));
    assert.deepEqual(loadSettings(dir).excludedExtensions, [join(dir, "extensions/no.ts"), "npm:example"]);
    assert.equal(loadSettings(dir).model?.modelId, "m");
    writeFileSync(file, '{"excludedExtensions":"bad"}');
    assert.throws(() => loadSettings(dir), /excludedExtensions/);
    writeFileSync(file, "null");
    assert.throws(() => loadSettings(dir), /expected an object/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("live tracker keeps bounded previews, no source references, deletes completed calls immediately", () => {
  const live = new LiveTools();
  const args = { command: "x".repeat(100000), secret: "not collected" };
  live.start({ toolCallId: "a", toolName: "bash", args });
  args.command = "changed";
  live.update({ toolCallId: "a", partialResult: { content: [{ type: "text", text: "y".repeat(100000) }] } });
  const first = live.snapshot().tools[0];
  assert.ok(first.input!.length < 350);
  assert.equal(first.output!.length, 320);
  assert.ok(!JSON.stringify(first).includes("secret"));
  assert.ok(!JSON.stringify(first).includes("changed"));
  live.end("a");
  assert.deepEqual(live.snapshot().tools, []);
  for (let i = 0; i < 1000; i++) live.start({ toolCallId: String(i), toolName: "read" });
  assert.equal(live.size, MAX_LIVE_TOOLS);
  assert.equal(live.snapshot({ limit: Infinity }).tools.length, 16);
  assert.equal(live.snapshot({ limit: 10000 }).tools.length, MAX_LIVE_TOOLS);
  live.clear();
  assert.equal(live.size, 0);
});
