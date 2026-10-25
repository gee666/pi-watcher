import { existsSync, realpathSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const bin = process.env.EVERGREEN_PI_BIN || "pi";
const executable = bin.includes("/") ? resolve(bin) : process.env.PATH?.split(delimiter)
  .map(dir => resolve(dir, bin)).find(path => existsSync(path));
if (!executable) throw new Error(`Pi executable not found: ${bin}`);
if (!process.env.EVERGREEN_E2E_MODEL) throw new Error("Set EVERGREEN_E2E_MODEL to a configured provider/model");
// Standalone global Pi has no importable CLI module. Watcher's RPC bootstrap
// needs the modular npm release installed by pretest; the e2e host is still global Pi.
const env = { ...process.env, EVERGREEN_PI_BIN: realpathSync(executable),
  PI_PACKAGE_DIR: resolve("node_modules/@earendil-works/pi-coding-agent") };
for (const [command, args] of [
  ["npm", ["test"]],
  [process.execPath, ["--test", "test/e2e/watcher.test.ts"]],
]) {
  const result = spawnSync(command, args, { env, stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
