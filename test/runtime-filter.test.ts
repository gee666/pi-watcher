import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyExclusions, compileExclusions, matchExclusion, normalizeSource } from "../src/runtime-filter.mjs";

function tree() {
	const root = mkdtempSync(join(tmpdir(), "pw-filter-"));
	const watcher = join(root, "pi-watcher");
	mkdirSync(join(watcher, "src"), { recursive: true });
	writeFileSync(join(watcher, "package.json"), JSON.stringify({ name: "oira666_pi-watcher" }));
	writeFileSync(join(watcher, "src", "index.ts"), "");
	writeFileSync(join(watcher, "src", "runtime-bridge-extension.ts"), "");
	const other = join(root, "other");
	mkdirSync(other, { recursive: true });
	writeFileSync(join(other, "package.json"), JSON.stringify({ name: "@scope/other-pkg" }));
	writeFileSync(join(other, "index.ts"), "");
	return { root, watcher, other, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const res = (path: string, metadata: Record<string, string> = { source: "local", scope: "user", origin: "top-level" }) => ({
	path,
	enabled: true,
	metadata,
});

test("watcher root excludes everything under it except the kept bridge", () => {
	const t = tree();
	try {
		const compiled = compileExclusions({
			cwd: t.root,
			roots: [t.watcher],
			keep: [join(t.watcher, "src", "runtime-bridge-extension.ts")],
		});
		assert.ok(matchExclusion(res(join(t.watcher, "src", "index.ts")), compiled));
		assert.equal(matchExclusion(res(join(t.watcher, "src", "runtime-bridge-extension.ts")), compiled), undefined);
		assert.equal(matchExclusion(res(join(t.other, "index.ts")), compiled), undefined);
		// package resource whose packageRoot is the watcher
		assert.ok(
			matchExclusion(
				res(join(t.watcher, "src", "index.ts"), { source: "npm:oira666_pi-watcher", scope: "user", origin: "package", packageRoot: t.watcher }),
				compiled,
			),
		);
	} finally {
		t.cleanup();
	}
});

test("realpath-aware: symlinked install of the watcher is still excluded", () => {
	const t = tree();
	try {
		const link = join(t.root, "linked-watcher");
		symlinkSync(t.watcher, link);
		const compiled = compileExclusions({ cwd: t.root, roots: [t.watcher] });
		assert.ok(matchExclusion(res(join(link, "src", "index.ts")), compiled));
		const compiled2 = compileExclusions({ cwd: t.root, roots: [link] });
		assert.ok(matchExclusion(res(join(t.watcher, "src", "index.ts")), compiled2));
	} finally {
		t.cleanup();
	}
});

test("entries: names, package names, sources, builtins, relative paths", () => {
	const t = tree();
	try {
		const compiled = compileExclusions({
			cwd: t.root,
			entries: ["@scope/other-pkg", "builtin:mcp", "npm:some-pkg@1.2.3", "git:github.com/me/repo@v1", "./pi-watcher"],
		});
		assert.match(String(matchExclusion(res(join(t.other, "index.ts")), compiled)), /package @scope\/other-pkg/);
		assert.ok(matchExclusion(res("builtin:mcp"), compiled));
		assert.equal(matchExclusion(res("builtin:codemode"), compiled), undefined);
		assert.ok(matchExclusion(res("/x/y.ts", { source: "npm:some-pkg@2.0.0", scope: "user", origin: "package" }), compiled));
		assert.ok(matchExclusion(res("/x/z.ts", { source: "https://github.com/me/repo.git", scope: "user", origin: "package" }), compiled));
		assert.ok(matchExclusion(res(join(t.watcher, "src", "index.ts")), compiled));
		const byName = compileExclusions({ cwd: t.root, entries: ["pi-watcher", "index-less"] });
		// index.ts → parent dir name
		assert.ok(matchExclusion(res(join(t.root, "pi-watcher", "index.ts")), byName));
	} finally {
		t.cleanup();
	}
});

test("normalizeSource strips versions and refs", () => {
	assert.equal(normalizeSource("npm:@a/b@1.0.0"), "npm:@a/b");
	assert.equal(normalizeSource("npm:pkg"), "npm:pkg");
	assert.equal(normalizeSource("https://github.com/x/y.git"), "git:github.com/x/y");
	assert.equal(normalizeSource("git:github.com/x/y@main"), "git:github.com/x/y");
	assert.equal(normalizeSource("git@github.com:x/y.git"), "git:github.com/x/y");
});

test("applyExclusions disables only matching enabled extensions and reports them", () => {
	const t = tree();
	try {
		const compiled = compileExclusions({ cwd: t.root, roots: [t.watcher] });
		const input = {
			extensions: [res(join(t.watcher, "src", "index.ts")), res(join(t.other, "index.ts")), { ...res("builtin:mcp"), enabled: false }],
			skills: [res(join(t.watcher, "skills", "a"))],
		};
		const { result, excluded } = applyExclusions(input, compiled);
		assert.deepEqual(
			result.extensions!.map((e) => e.enabled),
			[false, true, false],
		);
		assert.equal(excluded.length, 1);
		assert.equal((result as typeof input).skills, input.skills, "non-extension resources untouched");
		assert.equal(input.extensions[0]!.enabled, true, "input not mutated");
	} finally {
		t.cleanup();
	}
});
