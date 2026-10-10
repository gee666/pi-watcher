/**
 * IPC protocol between the WatcherRuntime (main pi process) and the side-agent child process.
 *
 * Transport: Node's built-in IPC channel (spawn stdio slot 3 = "ipc"). Every message carries
 * `pw: 1` so unrelated `process.send()` traffic can be ignored on both sides.
 */

export const IPC_TAG = 1 as const;

/** Global key the child entry uses to hand configuration to the bridge extension. */
export const CHILD_GLOBAL_KEY = "__PI_WATCHER_CHILD__";
/** Env var carrying the JSON child config (removed from process.env by the child entry). */
export const CHILD_CONFIG_ENV = "PI_WATCHER_CHILD_CONFIG";

/** Custom session entry type that links a side session to its main session. */
export const LINK_ENTRY_TYPE = "pi-watcher-link";

export const LIVE_MAIN_TOOLS_TOOL = "live_main_tools";
export const STEER_MAIN_TOOL = "steer_main";
export const BRIDGE_TOOL_NAMES = [LIVE_MAIN_TOOLS_TOOL, STEER_MAIN_TOOL] as const;

export type BridgeMethod = typeof LIVE_MAIN_TOOLS_TOOL | typeof STEER_MAIN_TOOL;

/** Configuration passed from the runtime to the child (env JSON → globalThis[CHILD_GLOBAL_KEY]). */
export interface ChildConfig {
	version: 1;
	/** Absolute path of the pi module exporting `main` and `DefaultPackageManager` (bundle/index.js). */
	piEntry: string;
	/** Executable Pi CLI exposed as process.argv[1] in the child. */
	piCliEntry: string;
	cwd: string;
	mainSessionId: string;
	mainSessionFile: string;
	sideSessionId: string;
	/** Exclusion spec consumed by runtime-filter.mjs */
	exclusions: { cwd: string; roots: string[]; entries: string[]; keep: string[] };
	/** pi docs directory, mentioned in the system prompt (session-format.md lives there). */
	piDocsDir?: string;
	/** Whether the parent supplied each callback (unavailable tools still exist but explain why). */
	capabilities: { liveMainTools: boolean; steerMain: boolean };
	/** Extra text appended to the watcher system-prompt section. */
	extraSystemPrompt?: string;
}

export interface LiveMainToolsParams {
	toolCallId?: string;
	limit?: number;
}

export interface SteerMainParams {
	message: string;
	mode?: "steer" | "followUp";
	rationale?: string;
}

export interface BridgeToolValue {
	text: string;
	details?: unknown;
	isError?: boolean;
}

export type LinkStatus =
	| { status: "created" }
	| { status: "matched" }
	| { status: "mismatch"; foundMainSessionId: string };

// ---- child → parent ----
export type ChildToParent =
	| { pw: 1; t: "excluded"; extensions: Array<{ path: string; reason: string }> }
	| { pw: 1; t: "fatal"; error: string }
	| { pw: 1; t: "hello"; sessionId: string; sessionFile?: string; link: LinkStatus; tools: string[] }
	| { pw: 1; t: "call"; id: string; method: BridgeMethod; params: unknown }
	| { pw: 1; t: "cancel"; id: string };

// ---- parent → child ----
export type ParentToChild =
	| { pw: 1; t: "result"; id: string; ok: true; value: BridgeToolValue }
	| { pw: 1; t: "result"; id: string; ok: false; error: string };

export function isIpcMessage(value: unknown): value is { pw: 1; t: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { pw?: unknown }).pw === IPC_TAG &&
		typeof (value as { t?: unknown }).t === "string"
	);
}
