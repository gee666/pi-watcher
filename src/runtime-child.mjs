// Child entry for the pi-watcher side agent.
//
// Runs pi's own CLI `main()` in RPC mode inside this process, after wrapping the public
// DefaultPackageManager so excluded extensions (the watcher itself + user exclusions) are marked
// disabled *before* pi imports them. Everything else (built-in MCP/codemode/tool_search, packages,
// providers, settings, auth, trust) behaves exactly like `pi --mode rpc`.
//
// Spawned by src/runtime.ts as: node runtime-child.mjs <pi args...>  with stdio [pipe,pipe,pipe,ipc]

import { pathToFileURL } from "node:url";
import { applyExclusions, compileExclusions } from "./runtime-filter.mjs";

const CHILD_GLOBAL_KEY = "__PI_WATCHER_CHILD__";
const CHILD_CONFIG_ENV = "PI_WATCHER_CHILD_CONFIG";

function send(message) {
	try {
		if (typeof process.send === "function" && process.connected) process.send({ pw: 1, ...message });
	} catch {
		// Parent gone; stdin EOF will shut pi down.
	}
}

function fatal(error) {
	const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr.write(`[pi-watcher child] ${text}\n`);
	send({ t: "fatal", error: error instanceof Error ? error.message : String(error) });
	// Give IPC a moment to flush.
	setTimeout(() => process.exit(3), 50);
}

async function run() {
	const raw = process.env[CHILD_CONFIG_ENV];
	delete process.env[CHILD_CONFIG_ENV];
	if (!raw) throw new Error(`${CHILD_CONFIG_ENV} is not set; this entry must be started by WatcherRuntime`);
	const config = JSON.parse(raw);
	Object.defineProperty(globalThis, CHILD_GLOBAL_KEY, { value: Object.freeze(config), enumerable: false });

	// If the parent disappears (IPC disconnect) make sure we do not linger; stdin EOF normally
	// triggers pi's own orderly RPC shutdown first.
	process.on("disconnect", () => {
		setTimeout(() => process.exit(0), 3000).unref();
	});

	// Inherited extensions launch subagents using execPath + argv[1]. Expose the real
	// CLI before importing Pi or loading extensions, not this IPC-only bootstrap.
	process.argv[1] = config.piCliEntry;

	const pi = await import(pathToFileURL(config.piEntry).href);
	const { DefaultPackageManager, main } = pi;
	if (typeof main !== "function") throw new Error(`pi entry ${config.piEntry} does not export main()`);
	const proto = DefaultPackageManager?.prototype;
	if (!proto || typeof proto.resolve !== "function" || typeof proto.resolveExtensionSources !== "function") {
		throw new Error(
			"Installed pi does not expose DefaultPackageManager.resolve/resolveExtensionSources; cannot exclude extensions safely",
		);
	}

	const compiled = compileExclusions(config.exclusions);
	const reported = new Set();
	const filter = (resolved) => {
		const { result, excluded } = applyExclusions(resolved, compiled);
		const fresh = excluded.filter((item) => !reported.has(item.path));
		for (const item of fresh) reported.add(item.path);
		if (fresh.length > 0) send({ t: "excluded", extensions: fresh });
		return result;
	};
	const originalResolve = proto.resolve;
	const originalResolveSources = proto.resolveExtensionSources;
	proto.resolve = async function patchedResolve(...args) {
		return filter(await originalResolve.apply(this, args));
	};
	proto.resolveExtensionSources = async function patchedResolveExtensionSources(...args) {
		return filter(await originalResolveSources.apply(this, args));
	};

	// Same process setup as pi's rpc-entry / cli setup.
	try {
		const { enableCompileCache } = await import("node:module");
		enableCompileCache?.();
	} catch {
		// optional
	}
	process.title = "pi-watcher-rpc";
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = () => {};

	await main(["--mode", "rpc", ...process.argv.slice(2)]);
}

run().catch(fatal);
