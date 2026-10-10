import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	deriveSideSessionId,
	inheritCliArgs,
	isValidSessionId,
	locatePi,
	parseUnknownOptions,
	readSessionHeader,
	removeFlags,
} from "../src/runtime-args.ts";

test("deriveSideSessionId is deterministic and valid", () => {
	const id = deriveSideSessionId("0199a7c2-1234-7abc-8def-0123456789ab");
	assert.equal(id, "watcher-0199a7c2-1234-7abc-8def-0123456789ab");
	assert.ok(isValidSessionId(id));
	assert.equal(deriveSideSessionId("a b/c"), "watcher-a-b-c");
	assert.ok(isValidSessionId(deriveSideSessionId("--x--")));
	assert.throws(() => deriveSideSessionId("///"));
	assert.equal(isValidSessionId("-bad"), false);
});

test("inheritCliArgs forwards resource/tool flags, skips model/session/mode flags", () => {
	const argv = [
		"node",
		"/pi/cli.js",
		"-e",
		"./ext.ts",
		"--extension",
		"npm:pkg",
		"--model",
		"sonnet",
		"--session",
		"abc",
		"-c",
		"--no-mcp",
		"-ns",
		"--tools",
		"read,bash",
		"-xt",
		"write,steer_main",
		"--approve",
		"--plan",
		"--depth=3",
		"--mode",
		"rpc",
		"--watcher",
		"--name",
		"x",
		"hello world",
	];
	const result = inheritCliArgs(argv, { parentCwd: "/work", dropFlags: ["watcher"] });
	assert.deepEqual(result.args, [
		"--extension",
		"/work/ext.ts",
		"--extension",
		"npm:pkg",
		"--no-mcp",
		"--no-skills",
		"--tools",
		"read,bash,live_main_tools,steer_main",
		"--exclude-tools",
		"write",
		"--approve",
		"--plan",
		"--depth=3",
	]);
	assert.deepEqual(result.extensionFlags, ["plan", "depth"]);
	assert.equal(result.hasApproveFlag, true);
	assert.equal(result.hasTools, true);
});

test("inheritCliArgs follows pi's value heuristic for unknown flags and stops at --", () => {
	const result = inheritCliArgs(["node", "pi", "--level", "high", "--flag", "-ne", "--", "--not-a-flag"], {});
	assert.deepEqual(result.args, ["--level=high", "--flag", "--no-extensions"]);
});

test("removeFlags and parseUnknownOptions", () => {
	assert.deepEqual(removeFlags(["--a", "--b=1", "--extension", "/x", "--c"], ["b", "c"]), ["--a", "--extension", "/x"]);
	assert.deepEqual(parseUnknownOptions("\u001b[31mError: Unknown options: --foo, --bar\u001b[39m\n"), ["foo", "bar"]);
	assert.deepEqual(parseUnknownOptions("Error: Unknown option: --solo\n"), ["solo"]);
	assert.deepEqual(parseUnknownOptions("nothing"), []);
});

test("readSessionHeader reads only the first line", () => {
	const dir = mkdtempSync(join(tmpdir(), "pw-hdr-"));
	try {
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "session", id: "abc", cwd: "/p" })}\n{"type":"message"}\n`);
		assert.equal(readSessionHeader(file)?.id, "abc");
		writeFileSync(file, "");
		assert.equal(readSessionHeader(file), undefined);
		writeFileSync(file, '{"type":"message"}\n');
		assert.equal(readSessionHeader(file), undefined);
		assert.equal(readSessionHeader(join(dir, "missing.jsonl")), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("locatePi resolves an executable CLI separately from the imported module", () => {
	const tmp = new URL("../tmp/", import.meta.url);
	mkdirSync(tmp, { recursive: true });
	const root = mkdtempSync(fileURLToPath(new URL("pi-location-", tmp)));
	try {
		mkdirSync(join(root, "dist", "bundle"), { recursive: true });
		writeFileSync(join(root, "dist", "bundle", "index.js"), "export function main() {}");
		const manifest = (bin: unknown) => writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin }));
		const locate = () => locatePi({ argv: ["node", join(root, "dist", "cli.js")], env: {} });
		manifest({ pi: "custom-cli.js" });
		writeFileSync(join(root, "custom-cli.js"), "");
		assert.equal(locate().cliEntry, join(root, "custom-cli.js"));
		manifest("custom-cli.js");
		assert.equal(locate().cliEntry, join(root, "custom-cli.js"));
		manifest({ pi: "missing.js" });
		writeFileSync(join(root, "dist", "cli.js"), "");
		assert.equal(locate().cliEntry, join(root, "dist", "cli.js"));
		writeFileSync(join(root, "dist", "bundle", "cli.js"), "");
		assert.equal(locate().cliEntry, join(root, "dist", "bundle", "cli.js"));
		assert.notEqual(locate().cliEntry, locate().entry);
		rmSync(join(root, "dist", "bundle", "cli.js"));
		rmSync(join(root, "dist", "cli.js"));
		assert.throws(locate, /Cannot locate/, "the import-only index is not an executable CLI");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("locatePi finds the installed pi package from argv or PI_PACKAGE_DIR", () => {
	try {
		const found = locatePi();
		assert.ok(found.entry.endsWith(".js"));
	} catch {
		// No pi in this environment: an explicit bogus dir must fail clearly.
	}
	assert.throws(() => locatePi({ piPackageDir: "/nonexistent", argv: ["node"], env: {} }), /Cannot locate/);
});
