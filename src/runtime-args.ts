/**
 * Pure helpers for building the side-agent child process: inherited CLI flags, side session id,
 * main-session header verification, pi package discovery.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BRIDGE_TOOL_NAMES } from "./runtime-protocol.ts";

// ---------------------------------------------------------------------------------------------
// Side session id
// ---------------------------------------------------------------------------------------------

/** Deterministic side-session id for a main session. Valid for `pi --session-id`. */
export function deriveSideSessionId(mainSessionId: string): string {
	const cleaned = String(mainSessionId)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[^A-Za-z0-9]+/, "")
		.replace(/[^A-Za-z0-9]+$/, "");
	if (!cleaned) throw new Error(`Cannot derive a side session id from main session id "${mainSessionId}"`);
	return `watcher-${cleaned}`.slice(0, 200).replace(/[^A-Za-z0-9]+$/, "");
}

export function isValidSessionId(id: string): boolean {
	return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id);
}

// ---------------------------------------------------------------------------------------------
// Main session header
// ---------------------------------------------------------------------------------------------

export interface MainSessionHeader {
	type: "session";
	id: string;
	cwd?: string;
	parentSession?: string;
	[key: string]: unknown;
}

/** Read the first JSONL line of a session file. Returns undefined if missing/empty/not a header. */
export function readSessionHeader(file: string, maxBytes = 1024 * 1024): MainSessionHeader | undefined {
	if (!existsSync(file)) return undefined;
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const chunks: Buffer[] = [];
		let total = 0;
		const buf = Buffer.alloc(64 * 1024);
		while (total < maxBytes) {
			const n = readSync(fd, buf, 0, buf.length, total);
			if (n <= 0) break;
			const chunk = Buffer.from(buf.subarray(0, n));
			const nl = chunk.indexOf(0x0a);
			if (nl !== -1) {
				chunks.push(chunk.subarray(0, nl));
				break;
			}
			chunks.push(chunk);
			total += n;
		}
		const line = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "").trim();
		if (!line) return undefined;
		const parsed = JSON.parse(line) as { type?: unknown; id?: unknown };
		if (parsed?.type !== "session" || typeof parsed.id !== "string") return undefined;
		return parsed as MainSessionHeader;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

// ---------------------------------------------------------------------------------------------
// pi package discovery
// ---------------------------------------------------------------------------------------------

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function findPiPackageUpward(start: string): string | undefined {
	let dir = start;
	for (let i = 0; i < 32; i++) {
		const pkg = readJson(join(dir, "package.json"));
		if (pkg?.name === PI_PACKAGE_NAME) return dir;
		// node_modules/.bin/pi → look into sibling package
		const sibling = join(dir, "node_modules", ...PI_PACKAGE_NAME.split("/"));
		if (readJson(join(sibling, "package.json"))?.name === PI_PACKAGE_NAME) return sibling;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

export interface PiLocation {
	packageDir: string;
	/** Module exporting `main` and `DefaultPackageManager` (bundle index, else unbundled index). */
	entry: string;
	docsDir?: string;
}

export function locatePi(options: { piPackageDir?: string; argv?: readonly string[]; env?: NodeJS.ProcessEnv } = {}): PiLocation {
	const env = options.env ?? process.env;
	const argv = options.argv ?? process.argv;
	const candidates: string[] = [];
	if (options.piPackageDir) candidates.push(resolve(options.piPackageDir));
	if (env.PI_PACKAGE_DIR) candidates.push(resolve(env.PI_PACKAGE_DIR));
	const script = argv[1];
	if (script && !script.startsWith("-")) {
		try {
			candidates.push(dirname(realpathSync(script)));
		} catch {
			candidates.push(dirname(resolve(script)));
		}
	}
	if (env.PI_MANAGED_INSTALL_ROOT) {
		const root = env.PI_MANAGED_INSTALL_ROOT;
		const version = (() => {
			try {
				return readFileSync(join(root, "current-version"), "utf8").trim();
			} catch {
				return undefined;
			}
		})();
		if (version) candidates.push(join(root, "releases", version));
	}
	for (const candidate of candidates) {
		const packageDir = findPiPackageUpward(candidate);
		if (!packageDir) continue;
		const entry = [join(packageDir, "dist", "bundle", "index.js"), join(packageDir, "dist", "index.js")].find((f) =>
			existsSync(f),
		);
		if (!entry) continue;
		const docsDir = join(packageDir, "docs");
		return { packageDir, entry, docsDir: existsSync(docsDir) ? docsDir : undefined };
	}
	throw new Error(
		`Cannot locate the ${PI_PACKAGE_NAME} package (tried: ${candidates.join(", ") || "none"}). Pass piPackageDir or set PI_PACKAGE_DIR.`,
	);
}

// ---------------------------------------------------------------------------------------------
// Inherited CLI flags
// ---------------------------------------------------------------------------------------------

/** Flags (with a value) whose value is a local path resolved against the parent's cwd. */
const PATH_VALUE_FLAGS = new Map<string, string>([
	["--extension", "--extension"],
	["-e", "--extension"],
	["--skill", "--skill"],
	["--prompt-template", "--prompt-template"],
	["--theme", "--theme"],
]);
/** Text-or-path value flags: resolve only if the value is an existing relative file. */
const TEXT_OR_PATH_FLAGS = new Set(["--system-prompt", "--append-system-prompt"]);
const LIST_VALUE_FLAGS = new Map<string, string>([
	["--tools", "--tools"],
	["-t", "--tools"],
	["--exclude-tools", "--exclude-tools"],
	["-xt", "--exclude-tools"],
]);
const FORWARD_BOOLEAN_FLAGS = new Map<string, string>([
	["--no-extensions", "--no-extensions"],
	["-ne", "--no-extensions"],
	["--no-mcp", "--no-mcp"],
	["--no-skills", "--no-skills"],
	["-ns", "--no-skills"],
	["--no-prompt-templates", "--no-prompt-templates"],
	["-np", "--no-prompt-templates"],
	["--no-themes", "--no-themes"],
	["--no-context-files", "--no-context-files"],
	["-nc", "--no-context-files"],
	["--approve", "--approve"],
	["-a", "--approve"],
	["--no-approve", "--no-approve"],
	["-na", "--no-approve"],
	["--offline", "--offline"],
	["--no-tools", "--no-tools"],
	["-nt", "--no-tools"],
	["--no-builtin-tools", "--no-builtin-tools"],
	["-nbt", "--no-builtin-tools"],
]);
/** Built-in flags NOT inherited (model, session, mode, output), with whether they take a value. */
const SKIP_FLAGS = new Map<string, boolean>([
	["--mode", true],
	["--provider", true],
	["--model", true],
	["--models", true],
	["--api-key", true],
	["--thinking", true],
	["--session", true],
	["--session-id", true],
	["--fork", true],
	["--session-dir", true],
	["--export", true],
	["--name", true],
	["-n", true],
	["--tui-mode", true],
	["--use-theme", true],
	["--continue", false],
	["-c", false],
	["--resume", false],
	["-r", false],
	["--no-session", false],
	["--print", false],
	["-p", false],
	["--help", false],
	["-h", false],
	["--version", false],
	["-v", false],
	["--verbose", false],
	["--list-models", false],
]);

export interface InheritedArgs {
	args: string[];
	/** Unknown long flags forwarded (names without dashes), for retry diagnostics. */
	extensionFlags: string[];
	hasTools: boolean;
	hasApproveFlag: boolean;
}

function isLocalPathValue(value: string): boolean {
	return !/^(npm:|git:|https?:\/\/|ssh:\/\/|git@|builtin:)/i.test(value);
}

/**
 * Parse the parent's argv (process.argv) and return the CLI args the side agent should inherit.
 * Follows pi's own parser rules (cli/args.js) for value detection of unknown flags.
 */
export function inheritCliArgs(
	argv: readonly string[],
	options: { parentCwd?: string; dropFlags?: readonly string[] } = {},
): InheritedArgs {
	const parentCwd = options.parentCwd ?? process.cwd();
	const drop = new Set((options.dropFlags ?? []).map((f) => f.replace(/^-+/, "")));
	const args: string[] = [];
	const extensionFlags: string[] = [];
	let hasTools = false;
	let hasApproveFlag = false;
	const list = argv.slice(2);
	for (let i = 0; i < list.length; i++) {
		const arg = list[i]!;
		if (arg === "--") break; // rest are messages
		const next = list[i + 1];
		const pathFlag = PATH_VALUE_FLAGS.get(arg);
		if (pathFlag) {
			if (next === undefined) continue;
			i++;
			const value = isLocalPathValue(next) && !isAbsolute(next) && !next.startsWith("~") ? resolve(parentCwd, next) : next;
			if (pathFlag !== "--theme") args.push(pathFlag, value);
			continue;
		}
		if (TEXT_OR_PATH_FLAGS.has(arg)) {
			if (next === undefined) continue;
			i++;
			const candidate = resolve(parentCwd, next);
			args.push(arg, !isAbsolute(next) && existsSync(candidate) ? candidate : next);
			continue;
		}
		const listFlag = LIST_VALUE_FLAGS.get(arg);
		if (listFlag) {
			if (next === undefined) continue;
			i++;
			if (listFlag === "--tools") {
				hasTools = true;
				const names = next.split(",").map((s) => s.trim()).filter(Boolean);
				for (const tool of BRIDGE_TOOL_NAMES) if (!names.includes(tool)) names.push(tool);
				args.push("--tools", names.join(","));
			} else {
				const names = next
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s && !(BRIDGE_TOOL_NAMES as readonly string[]).includes(s));
				if (names.length > 0) args.push("--exclude-tools", names.join(","));
			}
			continue;
		}
		const bool = FORWARD_BOOLEAN_FLAGS.get(arg);
		if (bool) {
			if (bool === "--approve" || bool === "--no-approve") hasApproveFlag = true;
			args.push(bool);
			continue;
		}
		if (SKIP_FLAGS.has(arg)) {
			if (arg === "--print" || arg === "-p") {
				// pi: --print may consume a following message argument; messages are not inherited anyway.
				continue;
			}
			if (arg === "--list-models") {
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) i++;
				continue;
			}
			if (SKIP_FLAGS.get(arg) && next !== undefined) i++;
			continue;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
			let value: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
			if (eq === -1 && next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
				value = next;
				i++;
			}
			if (!name || drop.has(name)) continue;
			extensionFlags.push(name);
			args.push(value === undefined ? `--${name}` : `--${name}=${value}`);
			continue;
		}
		// @files, messages, unknown short flags: not inherited.
	}
	return { args, extensionFlags, hasTools, hasApproveFlag };
}

/** Remove the given extension flags (names without dashes) from an arg list. */
export function removeFlags(args: readonly string[], names: readonly string[]): string[] {
	const drop = new Set(names.map((n) => n.replace(/^-+/, "")));
	return args.filter((arg) => {
		if (!arg.startsWith("--")) return true;
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		return !drop.has(name);
	});
}

/** Parse pi's "Unknown option(s): --a, --b" startup diagnostic. */
export function parseUnknownOptions(stderr: string): string[] {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colors
	const plain = stderr.replace(/\u001b\[[0-9;]*m/g, "");
	const match = /Unknown options?: ([^\n]+)/.exec(plain);
	if (!match) return [];
	return match[1]!
		.split(",")
		.map((s) => s.trim().replace(/^-+/, ""))
		.filter(Boolean);
}
