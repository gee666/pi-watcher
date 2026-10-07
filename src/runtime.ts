/**
 * pi-watcher side-agent runtime.
 *
 * Runs the side agent as a separate `pi --mode rpc` Node child process that inherits everything
 * the main pi CLI loads (built-in MCP/codemode/tool_search, all extensions and packages, custom
 * providers, settings, auth, models) except excluded extensions (always the watcher itself).
 * The side agent has its own persistent session (one per main session) and its own model.
 *
 * Side-only tools `live_main_tools` and `steer_main` are bridged back to this (main) process over
 * the Node IPC channel and answered by the callbacks passed to `start()`.
 *
 * Never sends a prompt on its own. The extension entry owns UI and approval.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { RpcExtensionUIRequest, RpcSessionState } from "@earendil-works/pi-coding-agent";
import {
	deriveSideSessionId,
	inheritCliArgs,
	isValidSessionId,
	locatePi,
	parseUnknownOptions,
	readSessionHeader,
	removeFlags,
} from "./runtime-args.ts";
import {
	type BridgeMethod,
	type BridgeToolValue,
	CHILD_CONFIG_ENV,
	CHILD_GLOBAL_KEY,
	type ChildConfig,
	type ChildToParent,
	isIpcMessage,
	type LinkStatus,
	LIVE_MAIN_TOOLS_TOOL,
	type LiveMainToolsParams,
	STEER_MAIN_TOOL,
	type SteerMainParams,
} from "./runtime-protocol.ts";
import { RpcConnection } from "./runtime-rpc.ts";

export { deriveSideSessionId } from "./runtime-args.ts";
export { BRIDGE_TOOL_NAMES, LINK_ENTRY_TYPE, LIVE_MAIN_TOOLS_TOOL, STEER_MAIN_TOOL } from "./runtime-protocol.ts";

// =================================================================================================
// Public types
// =================================================================================================

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WatcherRuntimeStatus = "idle" | "starting" | "ready" | "exited" | "disposed";
export type PromptDisposition = "started" | "queued" | "handled";

export interface LiveMainToolsRequest {
	mainSessionId: string;
	mainSessionFile: string;
	params: LiveMainToolsParams;
	signal: AbortSignal;
}

export type LiveMainToolsResult = string | BridgeToolValue;

export interface SteerMainRequest {
	mainSessionId: string;
	mainSessionFile: string;
	/** Message proposed by the side agent. The parent MUST show it to the human for approval. */
	message: string;
	mode: "steer" | "followUp";
	rationale?: string;
	/** Aborted if the side agent's tool call is aborted or the runtime is disposed. */
	signal: AbortSignal;
}

export interface SteerMainDecision {
	/** true only if a human approved and the parent delivered the message to the main session. */
	approved: boolean;
	/** Text actually delivered (if the human edited it). Defaults to the proposed message. */
	deliveredMessage?: string;
	/** Delivery mode actually used. Defaults to the requested mode. */
	mode?: "steer" | "followUp";
	/** Why it was declined / not delivered (shown to the side agent). */
	reason?: string;
}

export type UiDialogRequest = Extract<RpcExtensionUIRequest, { method: "select" | "confirm" | "input" | "editor" }>;
export type UiNotification = Exclude<RpcExtensionUIRequest, UiDialogRequest>;
export type UiDialogResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export interface WatcherRuntimeOptions {
	/** Main session working directory. The side agent runs here (same project resources/trust). */
	cwd: string;
	/** Absolute path of the main session JSONL file (named in the side agent's system prompt). */
	mainSessionFile: string;
	/** Main session id. Verified against the main session file header when it exists. */
	mainSessionId: string;
	/** Directory for side sessions (flat). Created if missing. */
	sessionDir: string;
	/** Additional extensions to exclude (paths, npm:/git: sources, builtin:<name>, or names). */
	excludedExtensions?: string[];
	/** pi-watcher package root, always excluded. Default: auto-detected from this file. */
	watcherRoot?: string;
	/** Independent model for the side agent (exact provider + id). */
	model?: { provider: string; modelId: string };
	thinkingLevel?: ThinkingLevel;
	/** Main project-trust decision (ctx.isProjectTrusted()): adds --approve / --no-approve. */
	projectTrusted?: boolean;
	/** Inherit resource/tool CLI flags from the main pi process argv. Default true. */
	inheritCliArgs?: boolean;
	/** argv to inherit from. Default process.argv. */
	parentArgv?: readonly string[];
	/** Extension flag names (without dashes) never forwarded, e.g. the watcher's own flags. */
	dropFlags?: string[];
	/** Extra CLI args for the child pi (after inherited ones). */
	extraArgs?: string[];
	/** Extra environment variables for the child. */
	env?: Record<string, string | undefined>;
	/** Override the derived side session id (`watcher-<mainSessionId>`). */
	sideSessionId?: string;
	/** Display name set once when the side session has none. */
	sessionName?: string;
	/** Extra text appended to the watcher system-prompt section. */
	extraSystemPrompt?: string;
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
	/** Discovery overrides. */
	piPackageDir?: string;
	nodePath?: string;

	/** Guard: current main session id; bridge calls are refused if it differs from mainSessionId. */
	getCurrentMainSessionId?: () => string | undefined;
	/** Live data about main's running/recent tool calls (parent's responsibility, keep it light). */
	liveMainTools?: (request: LiveMainToolsRequest) => Promise<LiveMainToolsResult> | LiveMainToolsResult;
	/** Human-approved steering of the main agent. MUST ask the human; never auto-approve. */
	steerMain?: (request: SteerMainRequest) => Promise<SteerMainDecision> | SteerMainDecision;
	/** Extension dialogs from the side agent (select/confirm/input/editor). Default: cancel. */
	onUiRequest?: (request: UiDialogRequest, context: { signal: AbortSignal }) => Promise<UiDialogResponse> | UiDialogResponse;
}

export interface WatcherRuntimeInfo {
	sideSessionId: string;
	sideSessionFile?: string;
	sessionDir: string;
	mainSessionId: string;
	mainSessionFile: string;
	cwd: string;
	pid?: number;
	piPackageDir: string;
	watcherRoot?: string;
	excludedExtensions: Array<{ path: string; reason: string }>;
	/** Bridge tools active in the side agent. */
	bridgeTools: string[];
	link: LinkStatus["status"];
	/** Child CLI args (after the entry script). */
	args: string[];
	/** Extension flags dropped after the child rejected them. */
	droppedFlags: string[];
	model?: { provider: string; id: string };
	/** Non-fatal problems (model could not be set, etc.). */
	warnings: string[];
}

export type WatcherRuntimeEvent =
	| { type: "status"; status: WatcherRuntimeStatus; error?: string }
	/** Any pi RPC session event (agent_start, message_update (delta-only), message_end, tool_execution_*, agent_settled, ...). */
	| { type: "session_event"; event: Record<string, unknown> & { type: string } }
	| { type: "ui"; request: UiNotification }
	| { type: "extension_error"; extensionPath?: string; event?: string; error?: string }
	| { type: "bridge"; method: BridgeMethod; callId: string; phase: "start" | "end"; ok?: boolean; error?: string }
	| { type: "stderr"; text: string }
	| { type: "exit"; code: number | null; signal: NodeJS.Signals | null; expected: boolean; error?: string }
	| { type: "warning"; message: string };

export type WatcherRuntimeListener = (event: WatcherRuntimeEvent) => void;

export type WatcherRuntimeErrorCode =
	| "INVALID_OPTIONS"
	| "INVALID_STATE"
	| "MAIN_SESSION_MISMATCH"
	| "SIDE_SESSION_MISMATCH"
	| "LOCKED"
	| "PI_NOT_FOUND"
	| "SPAWN_FAILED"
	| "STARTUP_FAILED"
	| "STARTUP_TIMEOUT"
	| "NOT_READY"
	| "DISPOSED";

export class WatcherRuntimeError extends Error {
	readonly code: WatcherRuntimeErrorCode;
	readonly stderr?: string;
	constructor(code: WatcherRuntimeErrorCode, message: string, stderr?: string) {
		super(message);
		this.name = "WatcherRuntimeError";
		this.code = code;
		this.stderr = stderr;
	}
}

/** True inside the side-agent child process (the watcher extension should then do nothing). */
export function isWatcherChildProcess(): boolean {
	return Boolean((globalThis as Record<string, unknown>)[CHILD_GLOBAL_KEY]);
}

/**
 * Convert side-session AgentMessages into simple transcript rows ({role, text}) for display.
 * user/assistant text is kept; assistant tool calls and tool results become short "tool" rows.
 */
export function messagesToTranscript(
	messages: readonly unknown[],
	options: { maxToolChars?: number } = {},
): Array<{ role: "user" | "assistant" | "tool"; text: string; ts?: number }> {
	const maxTool = options.maxToolChars ?? 400;
	const clip = (s: string) => (s.length > maxTool ? `${s.slice(0, maxTool)}…` : s);
	const textOf = (content: unknown): string => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((b: { type?: string; text?: string; mimeType?: string }) =>
				b?.type === "text" ? (b.text ?? "") : b?.type === "image" ? `[image ${b.mimeType ?? ""}]` : "",
			)
			.filter(Boolean)
			.join("\n");
	};
	const rows: Array<{ role: "user" | "assistant" | "tool"; text: string; ts?: number }> = [];
	for (const raw of messages) {
		const m = raw as { role?: string; content?: unknown; timestamp?: number; toolName?: string; isError?: boolean };
		const ts = typeof m?.timestamp === "number" ? m.timestamp : undefined;
		if (m?.role === "user") {
			const text = textOf(m.content);
			if (text) rows.push({ role: "user", text, ts });
		} else if (m?.role === "assistant" && Array.isArray(m.content)) {
			const text = textOf(m.content);
			if (text) rows.push({ role: "assistant", text, ts });
			for (const block of m.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
				if (block?.type === "toolCall") rows.push({ role: "tool", text: clip(`→ ${block.name}(${JSON.stringify(block.arguments ?? {})})`), ts });
			}
		} else if (m?.role === "toolResult") {
			rows.push({ role: "tool", text: clip(`${m.isError ? "✗" : "←"} ${m.toolName ?? "tool"}: ${textOf(m.content)}`), ts });
		}
	}
	return rows;
}

// =================================================================================================
// Internals
// =================================================================================================

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const HELLO_GRACE_MS = 15_000;
const STDERR_TAIL_BYTES = 64 * 1024;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function moduleDir(): string {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		// CommonJS transpilation fallback (jiti)
		return typeof __dirname === "string" ? __dirname : process.cwd();
	}
}

function defaultWatcherRoot(here: string): string {
	if (existsSync(join(here, "package.json"))) return here;
	return dirname(here);
}

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Locks held by runtimes in this process (same-process double start detection). */
const processLocks = new Set<string>();

class SessionLock {
	readonly path: string;
	private held = false;
	constructor(path: string) {
		this.path = path;
	}

	acquire(): void {
		const key = resolve(this.path);
		if (processLocks.has(key)) {
			throw new WatcherRuntimeError("LOCKED", `Another watcher runtime in this process already uses ${this.path}`);
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fd = openSync(this.path, "wx", 0o600);
				writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
				closeSync(fd);
				this.held = true;
				processLocks.add(key);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				let pid = 0;
				try {
					pid = Number((JSON.parse(readFileSync(this.path, "utf8")) as { pid?: number }).pid);
				} catch {
					pid = 0;
				}
				if (pid && pid !== process.pid && isPidAlive(pid)) {
					throw new WatcherRuntimeError(
						"LOCKED",
						`Side session is already in use by pi process ${pid} (lock ${this.path})`,
					);
				}
				// Stale (dead pid, or left behind by this process): remove and retry.
				try {
					unlinkSync(this.path);
				} catch {
					// raced
				}
			}
		}
		throw new WatcherRuntimeError("LOCKED", `Could not acquire side session lock ${this.path}`);
	}

	release(): void {
		if (!this.held) return;
		this.held = false;
		processLocks.delete(resolve(this.path));
		try {
			const owner = Number((JSON.parse(readFileSync(this.path, "utf8")) as { pid?: number }).pid);
			if (owner === process.pid) unlinkSync(this.path);
		} catch {
			// already gone
		}
	}
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	settled: boolean;
}

function deferred<T>(): Deferred<T> {
	let resolveFn!: (value: T) => void;
	let rejectFn!: (error: Error) => void;
	const d = {} as Deferred<T>;
	d.settled = false;
	d.promise = new Promise<T>((res, rej) => {
		resolveFn = res;
		rejectFn = rej;
	});
	d.promise.catch(() => undefined);
	d.resolve = (value) => {
		if (d.settled) return;
		d.settled = true;
		resolveFn(value);
	};
	d.reject = (error) => {
		if (d.settled) return;
		d.settled = true;
		rejectFn(error);
	};
	return d;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeBridgeValue(value: LiveMainToolsResult | undefined | null): BridgeToolValue {
	if (typeof value === "string") return { text: value };
	if (value && typeof value === "object" && typeof value.text === "string") {
		return { text: value.text, details: value.details, isError: value.isError === true ? true : undefined };
	}
	return { text: value === undefined || value === null ? "(no live data)" : JSON.stringify(value) };
}

interface ChildHandle {
	proc: ChildProcess;
	conn: RpcConnection;
	hello: Deferred<Extract<ChildToParent, { t: "hello" }>>;
	exited: Deferred<{ code: number | null; signal: NodeJS.Signals | null }>;
	fatalError?: string;
	stopping: boolean;
}

interface Resolved {
	options: WatcherRuntimeOptions;
	cwd: string;
	mainSessionFile: string;
	sessionDir: string;
	sideSessionId: string;
	watcherRoot?: string;
	bridgePath: string;
	childEntry: string;
	piPackageDir: string;
	piEntry: string;
	piDocsDir?: string;
	nodePath: string;
	baseArgs: string[];
	inheritedArgs: string[];
	inheritedFlags: string[];
	extraArgs: string[];
	startupTimeoutMs: number;
	requestTimeoutMs: number;
}

// =================================================================================================
// WatcherRuntime
// =================================================================================================

export class WatcherRuntime {
	/** Convenience: construct and start. */
	static async start(options: WatcherRuntimeOptions): Promise<WatcherRuntime> {
		const runtime = new WatcherRuntime();
		await runtime.start(options);
		return runtime;
	}

	private _status: WatcherRuntimeStatus = "idle";
	private listeners = new Set<WatcherRuntimeListener>();
	private options: WatcherRuntimeOptions | undefined;
	private resolved: Resolved | undefined;
	private child: ChildHandle | undefined;
	private lock: SessionLock | undefined;
	private _info: WatcherRuntimeInfo | undefined;
	private _stderr = "";
	private _busy = false;
	private settleCounter = 0;
	private settleWaiters = new Set<{ resolve: () => void; reject: (e: Error) => void }>();
	private bridgeCalls = new Map<string, AbortController>();
	private dialogControllers = new Set<AbortController>();
	private steerChain: Promise<unknown> = Promise.resolve();
	private exitHook: (() => void) | undefined;
	private startPromise: Promise<WatcherRuntimeInfo> | undefined;
	private disposePromise: Promise<void> | undefined;

	get status(): WatcherRuntimeStatus {
		return this._status;
	}
	get isBusy(): boolean {
		return this._busy;
	}
	get info(): WatcherRuntimeInfo | undefined {
		return this._info;
	}
	get stderrTail(): string {
		return this._stderr;
	}

	subscribe(listener: WatcherRuntimeListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// ----------------------------------------------------------------------------------------------
	// Lifecycle
	// ----------------------------------------------------------------------------------------------

	start(options: WatcherRuntimeOptions): Promise<WatcherRuntimeInfo> {
		if (this._status === "disposed") return Promise.reject(new WatcherRuntimeError("DISPOSED", "Runtime is disposed"));
		if (this._status === "starting" || this._status === "ready") {
			return Promise.reject(new WatcherRuntimeError("INVALID_STATE", `Runtime is already ${this._status}`));
		}
		this.options = options;
		this.startPromise = this.doStart(options).finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	/** Stop the child and start it again with the same options (same side session). */
	async restart(): Promise<WatcherRuntimeInfo> {
		if (this._status === "disposed") throw new WatcherRuntimeError("DISPOSED", "Runtime is disposed");
		if (!this.options) throw new WatcherRuntimeError("INVALID_STATE", "Runtime was never started");
		if (this.startPromise) await this.startPromise.catch(() => undefined);
		await this.stopChild();
		this.setStatus("idle");
		return this.start(this.options);
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposePromise = (async () => {
			const wasStarting = this.startPromise;
			this.setStatus("disposed");
			this.abortBridgeCalls("Watcher runtime disposed");
			await this.stopChild();
			if (wasStarting) await wasStarting.catch(() => undefined);
			await this.stopChild();
			this.rejectSettleWaiters(new WatcherRuntimeError("DISPOSED", "Runtime disposed"));
			this.lock?.release();
			this.removeExitHook();
			this.listeners.clear();
		})();
		return this.disposePromise;
	}

	// ----------------------------------------------------------------------------------------------
	// Side agent commands
	// ----------------------------------------------------------------------------------------------

	/** Prompt the SIDE agent. While it is busy pass streamingBehavior ("steer" | "followUp"). */
	async prompt(
		message: string,
		options: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" } = {},
	): Promise<PromptDisposition> {
		const before = this.settleCounter;
		const data = await this.request<{ disposition: PromptDisposition }>(
			{ type: "prompt", message, images: options.images, streamingBehavior: options.streamingBehavior },
			Math.max(this.requestTimeout(), 120_000),
		);
		const disposition = data?.disposition ?? "started";
		if (disposition === "started" && this.settleCounter === before) this._busy = true;
		return disposition;
	}

	/**
	 * Prompt the SIDE agent and wait until it settles. Subscribes before sending (no missed fast
	 * completions). `onTextDelta` receives assistant text deltas, `onEvent` every session event.
	 * Resolves with the last assistant text (null if the prompt was handled without a run).
	 */
	async promptAndWait(
		message: string,
		options: {
			images?: ImageContent[];
			onTextDelta?: (delta: string) => void;
			onEvent?: (event: Record<string, unknown> & { type: string }) => void;
			signal?: AbortSignal;
			timeoutMs?: number;
		} = {},
	): Promise<{ disposition: PromptDisposition; text: string | null }> {
		if (options.signal?.aborted) throw new Error("Aborted");
		const unsubscribe = this.subscribe((event) => {
			if (event.type !== "session_event") return;
			options.onEvent?.(event.event);
			if (event.event.type === "message_update") {
				const update = event.event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
				if (update?.type === "text_delta" && typeof update.delta === "string") options.onTextDelta?.(update.delta);
			}
		});
		const onAbort = () => {
			void this.abort().catch(() => undefined);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const disposition = await this.prompt(message, { images: options.images });
			if (disposition === "handled") return { disposition, text: null };
			await this.waitForSettled({ timeoutMs: options.timeoutMs });
			return { disposition, text: await this.getLastAssistantText() };
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			unsubscribe();
		}
	}

	async steer(message: string, images?: ImageContent[]): Promise<PromptDisposition> {
		return (await this.request<{ disposition: PromptDisposition }>({ type: "steer", message, images }))?.disposition;
	}

	async followUp(message: string, images?: ImageContent[]): Promise<PromptDisposition> {
		return (await this.request<{ disposition: PromptDisposition }>({ type: "follow_up", message, images }))?.disposition;
	}

	async abort(): Promise<void> {
		await this.request({ type: "abort" });
	}

	/** Resolve when the side agent has settled (immediately when idle). */
	waitForSettled(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
		if (!this._busy) return Promise.resolve();
		return new Promise<void>((resolvePromise, rejectPromise) => {
			let timer: NodeJS.Timeout | undefined;
			const waiter = {
				resolve: () => {
					cleanup();
					resolvePromise();
				},
				reject: (error: Error) => {
					cleanup();
					rejectPromise(error);
				},
			};
			const onAbort = () => waiter.reject(new Error("Aborted"));
			const cleanup = () => {
				this.settleWaiters.delete(waiter);
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			};
			if (options.signal?.aborted) return onAbort();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.timeoutMs && options.timeoutMs > 0) {
				timer = setTimeout(() => waiter.reject(new Error(`Side agent did not settle within ${options.timeoutMs}ms`)), options.timeoutMs);
			}
			this.settleWaiters.add(waiter);
		});
	}

	async getMessages(): Promise<AgentMessage[]> {
		return (await this.request<{ messages: AgentMessage[] }>({ type: "get_messages" }))?.messages ?? [];
	}

	getState(): Promise<RpcSessionState> {
		return this.request<RpcSessionState>({ type: "get_state" });
	}

	async getAvailableModels(): Promise<Model<string>[]> {
		return (await this.request<{ models: Model<string>[] }>({ type: "get_available_models" }))?.models ?? [];
	}

	/** Change the SIDE agent model. Does not persist pi's default model. */
	async setModel(provider: string, modelId: string): Promise<Model<string>> {
		const model = await this.request<Model<string>>({ type: "set_model", provider, modelId });
		if (this._info) this._info.model = { provider, id: modelId };
		return model;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.request({ type: "set_thinking_level", level });
	}

	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		return (await this.request<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" }))?.levels ?? [];
	}

	getSessionStats(): Promise<Record<string, unknown>> {
		return this.request({ type: "get_session_stats" });
	}

	getEntries(since?: string): Promise<{ entries: unknown[]; leafId: string | null }> {
		return this.request({ type: "get_entries", ...(since ? { since } : {}) });
	}

	compact(customInstructions?: string): Promise<Record<string, unknown>> {
		return this.request({ type: "compact", ...(customInstructions ? { customInstructions } : {}) }, 0);
	}

	clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return this.request({ type: "clear_queue" });
	}

	async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
		return (await this.request<{ commands: Array<{ name: string; description?: string; source: string }> }>({ type: "get_commands" }))
			?.commands ?? [];
	}

	async getLastAssistantText(): Promise<string | null> {
		return (await this.request<{ text: string | null }>({ type: "get_last_assistant_text" }))?.text ?? null;
	}

	/** Raw escape hatch for any pi RPC command. Resolves with the response `data`. */
	send<T = unknown>(command: { type: string; [key: string]: unknown }, timeoutMs?: number): Promise<T> {
		return this.request<T>(command, timeoutMs);
	}

	// ----------------------------------------------------------------------------------------------
	// Start implementation
	// ----------------------------------------------------------------------------------------------

	private async doStart(options: WatcherRuntimeOptions): Promise<WatcherRuntimeInfo> {
		this.setStatus("starting");
		try {
			const resolved = this.resolveOptions(options);
			this.resolved = resolved;
			if (!this.lock || this.lock.path !== join(resolved.sessionDir, `${resolved.sideSessionId}.lock`)) {
				this.lock?.release();
				this.lock = new SessionLock(join(resolved.sessionDir, `${resolved.sideSessionId}.lock`));
			}
			this.lock.acquire();
			this.installExitHook();

			let inherited = resolved.inheritedArgs;
			const droppedFlags: string[] = [];
			let info: WatcherRuntimeInfo | undefined;
			for (let attempt = 0; attempt < 2 && !info; attempt++) {
				try {
					info = await this.launch(resolved, inherited, droppedFlags);
				} catch (error) {
					const stderr = error instanceof WatcherRuntimeError ? (error.stderr ?? "") : "";
					const unknown = parseUnknownOptions(stderr).filter((name) => resolved.inheritedFlags.includes(name));
					if (attempt === 0 && unknown.length > 0 && this._status === "starting") {
						droppedFlags.push(...unknown);
						inherited = removeFlags(inherited, unknown);
						this.emit({
							type: "warning",
							message: `Side agent rejected inherited flags ${unknown.map((n) => `--${n}`).join(", ")}; retrying without them`,
						});
						continue;
					}
					throw error;
				}
			}
			if (!info) throw new WatcherRuntimeError("STARTUP_FAILED", "Side agent failed to start");
			if (this._status === "disposed") throw new WatcherRuntimeError("DISPOSED", "Runtime disposed during start");
			this._info = info;
			this.setStatus("ready");
			return info;
		} catch (error) {
			await this.stopChild();
			this.lock?.release();
			if (this._status !== "disposed") {
				this.removeExitHook();
				this.setStatus("idle", errorMessage(error));
			}
			throw error;
		}
	}

	private resolveOptions(options: WatcherRuntimeOptions): Resolved {
		const required = ["cwd", "mainSessionFile", "mainSessionId", "sessionDir"] as const;
		for (const key of required) {
			if (typeof options?.[key] !== "string" || !options[key].trim()) {
				throw new WatcherRuntimeError("INVALID_OPTIONS", `WatcherRuntime.start: "${key}" is required`);
			}
		}
		const cwd = resolve(options.cwd);
		if (!existsSync(cwd)) throw new WatcherRuntimeError("INVALID_OPTIONS", `cwd does not exist: ${cwd}`);
		const mainSessionFile = resolve(cwd, options.mainSessionFile);
		const header = readSessionHeader(mainSessionFile);
		if (header && header.id !== options.mainSessionId) {
			throw new WatcherRuntimeError(
				"MAIN_SESSION_MISMATCH",
				`Main session file ${mainSessionFile} has id ${header.id}, expected ${options.mainSessionId}`,
			);
		}
		const sessionDir = resolve(cwd, options.sessionDir);
		mkdirSync(sessionDir, { recursive: true });
		const sideSessionId = options.sideSessionId ?? deriveSideSessionId(options.mainSessionId);
		if (!isValidSessionId(sideSessionId)) {
			throw new WatcherRuntimeError("INVALID_OPTIONS", `Invalid side session id: ${sideSessionId}`);
		}

		let pi: ReturnType<typeof locatePi>;
		try {
			pi = locatePi({ piPackageDir: options.piPackageDir });
		} catch (error) {
			throw new WatcherRuntimeError("PI_NOT_FOUND", errorMessage(error));
		}

		const here = moduleDir();
		const bridgePath = join(here, "runtime-bridge-extension.ts");
		const childEntry = join(here, "runtime-child.mjs");
		for (const file of [bridgePath, childEntry]) {
			if (!existsSync(file)) throw new WatcherRuntimeError("STARTUP_FAILED", `Missing runtime file ${file}`);
		}
		// Default: the pi-watcher package root, i.e. the parent of src/. Deliberately not a free upward
		// package.json search, which could land on a directory containing unrelated extensions.
		let watcherRoot = options.watcherRoot ? resolve(cwd, options.watcherRoot) : defaultWatcherRoot(here);
		if (watcherRoot) {
			try {
				watcherRoot = realpathSync(watcherRoot);
			} catch {
				// keep as is
			}
		}

		const isBun = typeof (process.versions as Record<string, string | undefined>).bun === "string";
		const nodePath = options.nodePath ?? (isBun ? "node" : process.execPath);

		const inherited =
			options.inheritCliArgs === false
				? { args: [] as string[], extensionFlags: [] as string[], hasApproveFlag: false }
				: inheritCliArgs(options.parentArgv ?? process.argv, { parentCwd: process.cwd(), dropFlags: options.dropFlags });
		const inheritedArgs = [...inherited.args];
		if (options.projectTrusted !== undefined && !inherited.hasApproveFlag) {
			inheritedArgs.push(options.projectTrusted ? "--approve" : "--no-approve");
		}

		return {
			options,
			cwd,
			mainSessionFile,
			sessionDir,
			sideSessionId,
			watcherRoot,
			bridgePath,
			childEntry,
			piPackageDir: pi.packageDir,
			piEntry: pi.entry,
			piDocsDir: pi.docsDir,
			nodePath,
			baseArgs: ["--session-dir", sessionDir, "--session-id", sideSessionId, "--extension", bridgePath],
			inheritedArgs,
			inheritedFlags: inherited.extensionFlags,
			extraArgs: options.extraArgs ?? [],
			startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
			requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		};
	}

	private async launch(resolved: Resolved, inheritedArgs: string[], droppedFlags: string[]): Promise<WatcherRuntimeInfo> {
		const { options } = resolved;
		const args = [...resolved.baseArgs, ...inheritedArgs, ...resolved.extraArgs];
		const config: ChildConfig = {
			version: 1,
			piEntry: resolved.piEntry,
			cwd: resolved.cwd,
			mainSessionId: options.mainSessionId,
			mainSessionFile: resolved.mainSessionFile,
			sideSessionId: resolved.sideSessionId,
			exclusions: {
				cwd: resolved.cwd,
				roots: resolved.watcherRoot ? [resolved.watcherRoot] : [],
				entries: options.excludedExtensions ?? [],
				keep: [resolved.bridgePath],
			},
			piDocsDir: resolved.piDocsDir,
			capabilities: { liveMainTools: !!options.liveMainTools, steerMain: !!options.steerMain },
			extraSystemPrompt: options.extraSystemPrompt,
		};
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const [key, value] of Object.entries(options.env ?? {})) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
		env[CHILD_CONFIG_ENV] = JSON.stringify(config);

		this._stderr = "";
		const excluded: Array<{ path: string; reason: string }> = [];
		let proc: ChildProcess;
		try {
			proc = spawn(resolved.nodePath, [resolved.childEntry, ...args], {
				cwd: resolved.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe", "ipc"],
				serialization: "json",
				windowsHide: true,
			});
		} catch (error) {
			throw new WatcherRuntimeError("SPAWN_FAILED", `Failed to spawn side agent: ${errorMessage(error)}`);
		}

		const handle: ChildHandle = {
			proc,
			conn: undefined as unknown as RpcConnection,
			hello: deferred(),
			exited: deferred(),
			stopping: false,
		};
		handle.conn = new RpcConnection(proc.stdin!, proc.stdout!, {
			onRecord: (record) => this.handleRecord(handle, record),
			onProtocolNoise: (line, reason) => this.appendStderr(`[pi-watcher] ignored stdout line (${reason}): ${line.slice(0, 200)}\n`),
		});
		this.child = handle;

		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => this.appendStderr(chunk));
		proc.on("message", (message) => this.handleIpc(handle, message, excluded));
		// Persistent: ChildProcess can emit "error" more than once (spawn failure, kill/send failures).
		proc.on("error", (error) => {
			const alive = proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null;
			if (alive) {
				// e.g. a failed kill()/send(): the child is still running; keep it, just report.
				this.emit({ type: "warning", message: `Side agent process error: ${error.message}` });
				return;
			}
			const err = new WatcherRuntimeError("SPAWN_FAILED", `Side agent process error: ${error.message}`, this._stderr);
			handle.conn.close(err);
			handle.hello.reject(err);
			handle.exited.resolve({ code: null, signal: null });
			if (this.child === handle) this.onChildGone(handle, null, null, err.message);
		});
		proc.once("exit", (code, signal) => {
			handle.exited.resolve({ code, signal });
			const reason = handle.fatalError ?? `Side agent exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`;
			const err = new WatcherRuntimeError(handle.hello.settled ? "NOT_READY" : "STARTUP_FAILED", reason, this._stderr);
			handle.conn.close(err);
			handle.hello.reject(err);
			if (this.child === handle) this.onChildGone(handle, code, signal, handle.stopping ? undefined : reason);
		});

		// ---- wait for readiness ----
		const deadline = Date.now() + resolved.startupTimeoutMs;
		const remaining = () => Math.max(1, deadline - Date.now());
		const failure = (code: WatcherRuntimeErrorCode, message: string) =>
			new WatcherRuntimeError(code, `${message}${this._stderr ? `\n--- side agent stderr ---\n${this._stderr.slice(-4000)}` : ""}`, this._stderr);

		const exitedEarly = handle.exited.promise.then(() => {
			throw failure("STARTUP_FAILED", handle.fatalError ?? "Side agent exited during startup");
		});
		const withTimeout = <T>(promise: Promise<T>, what: string): Promise<T> => {
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(failure("STARTUP_TIMEOUT", `Timed out waiting for ${what}`)), remaining());
			});
			return Promise.race([promise, exitedEarly, timeout]).finally(() => clearTimeout(timer));
		};

		let state: RpcSessionState;
		try {
			state = await withTimeout(handle.conn.request<RpcSessionState>({ type: "get_state" }), "side agent RPC");
		} catch (error) {
			if (error instanceof WatcherRuntimeError) throw error;
			throw failure("STARTUP_FAILED", `Side agent RPC failed: ${errorMessage(error)}`);
		}
		let hello: Extract<ChildToParent, { t: "hello" }>;
		try {
			const helloDeadline = Math.min(remaining(), HELLO_GRACE_MS);
			let timer: NodeJS.Timeout | undefined;
			hello = await Promise.race([
				handle.hello.promise,
				exitedEarly,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(failure("STARTUP_FAILED", "Side agent bridge extension did not start (no hello)")),
						helloDeadline,
					);
				}),
			]).finally(() => clearTimeout(timer));
		} catch (error) {
			if (error instanceof WatcherRuntimeError) throw error;
			throw failure("STARTUP_FAILED", errorMessage(error));
		}

		if (state.sessionId !== resolved.sideSessionId || hello.sessionId !== resolved.sideSessionId) {
			throw failure(
				"SIDE_SESSION_MISMATCH",
				`Side agent opened session ${state.sessionId}, expected ${resolved.sideSessionId}`,
			);
		}
		if (hello.link.status === "mismatch") {
			throw failure(
				"SIDE_SESSION_MISMATCH",
				`Side session ${resolved.sideSessionId} is linked to main session ${hello.link.foundMainSessionId}, not ${options.mainSessionId}`,
			);
		}

		const warnings: string[] = [];
		const hasModel = (m: { provider?: string } | undefined) => !!m?.provider && m.provider !== "unknown";
		let model = hasModel(state.model) ? { provider: state.model!.provider, id: state.model!.id } : undefined;
		// Desired model: explicit option, else (if pi failed to resolve one at startup, which can happen
		// transiently while the model/auth snapshot is refreshed) the side session's last selection or
		// the configured default.
		// options.model / options.thinkingLevel are initial defaults only: a reopened side session keeps
		// the model/thinking the user selected earlier (persisted as session entries).
		const freshSession = hello.link.status === "created";
		let desired = freshSession ? options.model : undefined;
		if (!desired && !model) desired = (await this.recoverModelChoice(handle, resolved)) ?? options.model;
		if (desired && (model?.provider !== desired.provider || model?.id !== desired.modelId)) {
			let lastError: unknown;
			for (let attempt = 0; attempt < 4 && (attempt === 0 || remaining() > 1000); attempt++) {
				try {
					await handle.conn.request({ type: "set_model", provider: desired.provider, modelId: desired.modelId }, resolved.requestTimeoutMs);
					model = { provider: desired.provider, id: desired.modelId };
					lastError = undefined;
					break;
				} catch (error) {
					lastError = error;
					await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
				}
			}
			if (lastError) warnings.push(`Could not set side model ${desired.provider}/${desired.modelId}: ${errorMessage(lastError)}`);
		}
		if (!model) warnings.push("Side agent has no usable model; choose one with setModel()");
		if (options.thinkingLevel && freshSession) {
			try {
				await handle.conn.request({ type: "set_thinking_level", level: options.thinkingLevel }, resolved.requestTimeoutMs);
			} catch (error) {
				warnings.push(`Could not set thinking level ${options.thinkingLevel}: ${errorMessage(error)}`);
			}
		}
		if (!state.sessionName) {
			const name = options.sessionName ?? `watcher: ${options.mainSessionId.slice(0, 8)}`;
			try {
				await handle.conn.request({ type: "set_session_name", name }, resolved.requestTimeoutMs);
			} catch (error) {
				warnings.push(`Could not name side session: ${errorMessage(error)}`);
			}
		}
		const missingTools = [LIVE_MAIN_TOOLS_TOOL, STEER_MAIN_TOOL].filter((t) => !hello.tools.includes(t));
		if (missingTools.length > 0) warnings.push(`Bridge tools not active in side agent: ${missingTools.join(", ")}`);
		for (const message of warnings) this.emit({ type: "warning", message });
		this._busy = state.isStreaming === true;

		return {
			sideSessionId: resolved.sideSessionId,
			sideSessionFile: state.sessionFile ?? hello.sessionFile,
			sessionDir: resolved.sessionDir,
			mainSessionId: options.mainSessionId,
			mainSessionFile: resolved.mainSessionFile,
			cwd: resolved.cwd,
			pid: proc.pid,
			piPackageDir: resolved.piPackageDir,
			watcherRoot: resolved.watcherRoot,
			excludedExtensions: excluded,
			bridgeTools: hello.tools,
			link: hello.link.status,
			args,
			droppedFlags: [...droppedFlags],
			model,
			warnings,
		};
	}

	/** Last model selected in the side session, else pi's configured default (agent/project settings). */
	private async recoverModelChoice(
		handle: ChildHandle,
		resolved: Resolved,
	): Promise<{ provider: string; modelId: string } | undefined> {
		try {
			const data = await handle.conn.request<{ entries: Array<Record<string, unknown>> }>(
				{ type: "get_entries" },
				resolved.requestTimeoutMs,
			);
			const entries = data?.entries ?? [];
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i]!;
				if (e.type === "model_change" && typeof e.provider === "string" && typeof e.modelId === "string") {
					return { provider: e.provider, modelId: e.modelId };
				}
			}
		} catch {
			// fall through to settings
		}
		const env = { ...process.env, ...(resolved.options.env ?? {}) };
		const agentDir = env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
		let provider: string | undefined;
		let modelId: string | undefined;
		const files = [join(agentDir, "settings.json")];
		if (resolved.options.projectTrusted === true) files.push(join(resolved.cwd, ".pi", "settings.json"));
		for (const file of files) {
			try {
				const s = JSON.parse(readFileSync(file, "utf8")) as { defaultProvider?: unknown; defaultModel?: unknown };
				if (typeof s.defaultProvider === "string") provider = s.defaultProvider;
				if (typeof s.defaultModel === "string") modelId = s.defaultModel;
			} catch {
				// missing/invalid
			}
		}
		return provider && modelId ? { provider, modelId } : undefined;
	}

	// ----------------------------------------------------------------------------------------------
	// Child I/O
	// ----------------------------------------------------------------------------------------------

	private handleRecord(handle: ChildHandle, record: Record<string, unknown>): void {
		if (this.child !== handle) return;
		const type = record.type;
		if (type === "extension_ui_request") {
			this.handleUiRequest(handle, record as unknown as RpcExtensionUIRequest);
			return;
		}
		if (type === "extension_error") {
			this.emit({
				type: "extension_error",
				extensionPath: record.extensionPath as string | undefined,
				event: record.event as string | undefined,
				error: record.error as string | undefined,
			});
			return;
		}
		if (typeof type !== "string") return;
		if (type === "agent_start") this._busy = true;
		if (type === "agent_settled") {
			this.settleCounter++;
			this._busy = false;
			for (const waiter of [...this.settleWaiters]) waiter.resolve();
		}
		this.emit({ type: "session_event", event: record as Record<string, unknown> & { type: string } });
	}

	private handleUiRequest(handle: ChildHandle, request: RpcExtensionUIRequest): void {
		if (!DIALOG_METHODS.has(request.method)) {
			this.emit({ type: "ui", request: request as UiNotification });
			return;
		}
		const dialog = request as UiDialogRequest;
		const controller = new AbortController();
		this.dialogControllers.add(controller);
		const respond = (response: UiDialogResponse) => {
			this.dialogControllers.delete(controller);
			if (handle.conn.closed || this.child !== handle) return;
			handle.conn.write({ type: "extension_ui_response", id: dialog.id, ...response }).catch(() => undefined);
		};
		const handler = this.options?.onUiRequest;
		if (!handler) {
			respond({ cancelled: true });
			return;
		}
		Promise.resolve()
			.then(() => handler(dialog, { signal: controller.signal }))
			.then(
				(response) => respond(response && typeof response === "object" ? response : { cancelled: true }),
				() => respond({ cancelled: true }),
			);
	}

	private handleIpc(handle: ChildHandle, message: unknown, excluded: Array<{ path: string; reason: string }>): void {
		if (this.child !== handle || !isIpcMessage(message)) return;
		const msg = message as ChildToParent;
		switch (msg.t) {
			case "excluded":
				for (const item of msg.extensions ?? []) {
					if (!excluded.some((e) => e.path === item.path)) excluded.push(item);
				}
				return;
			case "fatal":
				handle.fatalError = msg.error;
				return;
			case "hello":
				if (!handle.hello.settled) handle.hello.resolve(msg);
				else if (this._info) {
					// session_start after a reload inside the child
					this._info.bridgeTools = msg.tools;
					if (msg.link.status === "mismatch") {
						this.emit({ type: "warning", message: "Side session link mismatch after reload; bridge disabled" });
					}
				}
				return;
			case "call":
				void this.handleBridgeCall(handle, msg.id, msg.method, msg.params);
				return;
			case "cancel":
				this.bridgeCalls.get(msg.id)?.abort();
				return;
		}
	}

	private async handleBridgeCall(handle: ChildHandle, id: string, method: BridgeMethod, params: unknown): Promise<void> {
		const controller = new AbortController();
		this.bridgeCalls.set(id, controller);
		this.emit({ type: "bridge", method, callId: id, phase: "start" });
		let reply: { ok: true; value: BridgeToolValue } | { ok: false; error: string };
		try {
			const value =
				method === LIVE_MAIN_TOOLS_TOOL
					? await this.runLiveMainTools(params, controller.signal)
					: method === STEER_MAIN_TOOL
						? await this.runSteerMain(params, controller.signal)
						: (() => {
								throw new Error(`Unknown bridge method ${String(method)}`);
							})();
			reply = { ok: true, value };
		} catch (error) {
			reply = { ok: false, error: errorMessage(error) };
		} finally {
			this.bridgeCalls.delete(id);
		}
		this.emit({ type: "bridge", method, callId: id, phase: "end", ok: reply.ok, error: reply.ok ? undefined : reply.error });
		if (this.child !== handle || !handle.proc.connected) return;
		try {
			// Callback form: a failed send is reported to the callback instead of an "error" event/throw.
			handle.proc.send({ pw: 1, t: "result", id, ...reply }, (error) => {
				if (error) this.emit({ type: "warning", message: `Could not deliver ${method} result: ${error.message}` });
			});
		} catch {
			// child gone
		}
	}

	private assertMainSession(): { mainSessionId: string; mainSessionFile: string } {
		const options = this.options;
		const resolved = this.resolved;
		if (!options || !resolved) throw new Error("Watcher runtime is not started");
		const current = options.getCurrentMainSessionId?.();
		if (options.getCurrentMainSessionId && current !== options.mainSessionId) {
			throw new Error(
				`The main session changed (now ${current ?? "none"}); this watcher belongs to ${options.mainSessionId}. Refusing.`,
			);
		}
		return { mainSessionId: options.mainSessionId, mainSessionFile: resolved.mainSessionFile };
	}

	private async runLiveMainTools(params: unknown, signal: AbortSignal): Promise<BridgeToolValue> {
		const handler = this.options?.liveMainTools;
		if (!handler) throw new Error("live_main_tools is not available");
		const main = this.assertMainSession();
		const raw = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
		const clean: LiveMainToolsParams = {};
		if (typeof raw.toolCallId === "string" && raw.toolCallId) clean.toolCallId = raw.toolCallId;
		if (typeof raw.limit === "number" && Number.isFinite(raw.limit)) clean.limit = Math.max(1, Math.min(200, Math.floor(raw.limit)));
		return normalizeBridgeValue(await handler({ ...main, params: clean, signal }));
	}

	private runSteerMain(params: unknown, signal: AbortSignal): Promise<BridgeToolValue> {
		const handler = this.options?.steerMain;
		if (!handler) return Promise.reject(new Error("steer_main is not available"));
		const raw = (params && typeof params === "object" ? params : {}) as Partial<SteerMainParams>;
		const message = typeof raw.message === "string" ? raw.message.trim() : "";
		if (!message) return Promise.reject(new Error("steer_main requires a non-empty message"));
		const mode: "steer" | "followUp" = raw.mode === "followUp" ? "followUp" : "steer";
		const rationale = typeof raw.rationale === "string" && raw.rationale.trim() ? raw.rationale.trim() : undefined;

		// One approval at a time: queue behind earlier steer requests.
		const run = async (): Promise<BridgeToolValue> => {
			if (signal.aborted) throw new Error("Aborted");
			const main = this.assertMainSession();
			const decision = await handler({ ...main, message, mode, rationale, signal });
			if (signal.aborted) throw new Error("Aborted");
			if (!decision || decision.approved !== true) {
				const reason = decision?.reason ? `: ${decision.reason}` : "";
				return {
					text: `The human declined this steer_main message${reason}. It was NOT delivered to the main agent. Do not retry unless the human asks again.`,
					details: { approved: false, reason: decision?.reason, proposed: message, mode },
				};
			}
			const delivered = decision.deliveredMessage ?? message;
			const deliveredMode = decision.mode ?? mode;
			const edited = delivered !== message;
			return {
				text: `Approved by the human and delivered to the main agent as ${deliveredMode}${edited ? " (edited by the human)" : ""}:\n${delivered}`,
				details: { approved: true, mode: deliveredMode, delivered, edited },
			};
		};
		const result = this.steerChain.then(run, run);
		this.steerChain = result.catch(() => undefined);
		return result;
	}

	private abortBridgeCalls(_reason: string): void {
		for (const controller of this.bridgeCalls.values()) controller.abort();
		this.bridgeCalls.clear();
		for (const controller of this.dialogControllers) controller.abort();
		this.dialogControllers.clear();
	}

	private onChildGone(handle: ChildHandle, code: number | null, signal: NodeJS.Signals | null, error?: string): void {
		if (this.child !== handle) return;
		this.child = undefined;
		this.abortBridgeCalls("side agent exited");
		this._busy = false;
		this.rejectSettleWaiters(new Error(error ?? "Side agent exited"));
		const expected = handle.stopping || this._status === "disposed";
		const wasReady = this._status === "ready";
		this.emit({ type: "exit", code, signal, expected, error });
		if (wasReady) {
			this.lock?.release();
			this.removeExitHook();
			this.setStatus("exited", error);
		}
	}

	private rejectSettleWaiters(error: Error): void {
		for (const waiter of [...this.settleWaiters]) waiter.reject(error);
	}

	private async stopChild(): Promise<void> {
		const handle = this.child;
		if (!handle) return;
		handle.stopping = true;
		const { proc } = handle;
		if (proc.exitCode === null && proc.signalCode === null) {
			try {
				proc.stdin?.end();
			} catch {
				// ignore
			}
			const waitExit = (ms: number) =>
				Promise.race([handle.exited.promise.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref?.())]);
			if (!(await waitExit(4000))) {
				try {
					proc.kill("SIGTERM");
				} catch {
					// ignore
				}
				if (!(await waitExit(2000))) {
					try {
						proc.kill("SIGKILL");
					} catch {
						// ignore
					}
					await waitExit(2000);
				}
			}
		}
		handle.conn.close(new WatcherRuntimeError("NOT_READY", "Side agent stopped"));
		if (this.child === handle) this.onChildGone(handle, proc.exitCode, proc.signalCode);
	}

	private installExitHook(): void {
		if (this.exitHook) return;
		this.exitHook = () => {
			try {
				const proc = this.child?.proc;
				if (proc && proc.exitCode === null) proc.kill("SIGTERM");
			} catch {
				// ignore
			}
			this.lock?.release();
		};
		process.once("exit", this.exitHook);
	}

	private removeExitHook(): void {
		if (!this.exitHook) return;
		process.off("exit", this.exitHook);
		this.exitHook = undefined;
	}

	// ----------------------------------------------------------------------------------------------
	// Helpers
	// ----------------------------------------------------------------------------------------------

	private requestTimeout(): number {
		return this.resolved?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	private request<T>(command: { type: string; [key: string]: unknown }, timeoutMs?: number): Promise<T> {
		if (this._status === "disposed") return Promise.reject(new WatcherRuntimeError("DISPOSED", "Runtime is disposed"));
		const handle = this.child;
		if (this._status !== "ready" || !handle) {
			return Promise.reject(new WatcherRuntimeError("NOT_READY", `Side agent is not ready (status: ${this._status})`));
		}
		return handle.conn.request<T>(command, timeoutMs ?? this.requestTimeout());
	}

	private appendStderr(text: string): void {
		this._stderr = (this._stderr + text).slice(-STDERR_TAIL_BYTES);
		this.emit({ type: "stderr", text });
	}

	private setStatus(status: WatcherRuntimeStatus, error?: string): void {
		if (this._status === "disposed" && status !== "disposed") return;
		if (this._status === status && !error) return;
		this._status = status;
		this.emit({ type: "status", status, ...(error ? { error } : {}) });
	}

	private emit(event: WatcherRuntimeEvent): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch {
				// listener errors must not break the runtime
			}
		}
	}
}
