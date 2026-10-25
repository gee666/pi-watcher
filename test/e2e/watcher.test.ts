import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("global Pi: Watcher observes main history and live tools, preserves main, and resumes independently", { timeout: 180_000 }, async () => {
  const model = process.env.EVERGREEN_E2E_MODEL;
  assert.ok(model, "EVERGREEN_E2E_MODEL is required (no offline substitute)");
  const root = mkdtempSync(join(tmpdir(), "watcher-evergreen-"));
  const agent = join(root, "agent");
  mkdirSync(agent);
  // Reuse configured credentials, but never change the user's settings or sessions.
  const source = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  for (const name of ["auth.json", "models.json"]) {
    if (existsSync(join(source, name))) copyFileSync(join(source, name), join(agent, name));
  }
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ cacheWarming: { enabled: false } }));
  const report = join(root, "report.json");
  try {
    const child = spawn(process.env.EVERGREEN_PI_BIN || "pi", [
      "--print", "--mode", "json", "--model", model,
      "--session", join(root, "main.jsonl"),
      "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
      "--extension", resolve("src/index.ts"),
      "--extension", resolve("test/fixtures/evergreen-probe.ts"),
      "Reply only with ACK. This main session's observation token is EVERGREEN_MAIN_7c91. Do not use tools.",
    ], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agent, EVERGREEN_REPORT: report, PI_SKIP_VERSION_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 165_000);
    try {
      const code = await new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", resolveExit);
      });
      assert.equal(code, 0, `${stderr}\n${stdout}`);
      assert.ok(existsSync(report), `Pi did not run the probe: ${stderr}\n${stdout}`);
      const result: unknown = JSON.parse(readFileSync(report, "utf8"));
      assert.ok(typeof result === "object" && result !== null && "ok" in result && result.ok === true,
        JSON.stringify(result));
    } finally { clearTimeout(timer); child.kill(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
