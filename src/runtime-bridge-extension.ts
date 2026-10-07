/**
 * pi-watcher bridge extension — loaded ONLY inside the side-agent child process (via `-e`).
 *
 * - Registers the side-only tools `live_main_tools` and `steer_main`, which call back into the
 *   main pi process over the Node IPC channel (see runtime-protocol.ts).
 * - Adds the watcher system-prompt section on every run.
 * - Pins the side session to its main session with a `pi-watcher-link` custom entry and reports
 *   the link status to the parent, which refuses to run on a mismatch.
 *
 * Outside a watcher child (no config on globalThis) it does nothing.
 */

import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildWatcherSystemPrompt, WATCHER_SECTION_KEY } from "./runtime-prompt.ts";
import {
	BRIDGE_TOOL_NAMES,
	type BridgeMethod,
	type BridgeToolValue,
	CHILD_GLOBAL_KEY,
	type ChildConfig,
	isIpcMessage,
	LINK_ENTRY_TYPE,
	LIVE_MAIN_TOOLS_TOOL,
	type LinkStatus,
	type ParentToChild,
	STEER_MAIN_TOOL,
} from "./runtime-protocol.ts";

interface PendingCall {
	resolve: (value: BridgeToolValue) => void;
	reject: (error: Error) => void;
}

function getConfig(): ChildConfig | undefined {
	const value = (globalThis as Record<string, unknown>)[CHILD_GLOBAL_KEY];
	if (!value || typeof value !== "object") return undefined;
	return value as ChildConfig;
}

function sendToParent(message: Record<string, unknown>): boolean {
	try {
		if (typeof process.send !== "function" || !process.connected) return false;
		process.send({ pw: 1, ...message });
		return true;
	} catch {
		return false;
	}
}

function textResult(value: BridgeToolValue) {
	return {
		content: [{ type: "text" as const, text: value.text }],
		details: value.details as undefined,
		...(value.isError ? { isError: true } : {}),
	};
}

function findLink(ctx: ExtensionContext): { mainSessionId?: string; mainSessionFile?: string } | undefined {
	let found: { mainSessionId?: string; mainSessionFile?: string } | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		const e = entry as { type?: string; customType?: string; data?: unknown };
		if (e.type === "custom" && e.customType === LINK_ENTRY_TYPE && e.data && typeof e.data === "object") {
			found = e.data as { mainSessionId?: string; mainSessionFile?: string };
		}
	}
	return found;
}

export default function piWatcherBridge(pi: ExtensionAPI): void {
	const config = getConfig();
	if (!config) return;

	const pending = new Map<string, PendingCall>();
	let attached = false;
	let linkMismatch: string | undefined;

	const onMessage = (message: unknown) => {
		if (!isIpcMessage(message) || message.t !== "result") return;
		const result = message as ParentToChild;
		const call = pending.get(result.id);
		if (!call) return;
		pending.delete(result.id);
		if (result.ok) call.resolve(result.value);
		else call.reject(new Error(result.error));
	};
	/** Reject all in-flight calls; when the parent is still connected, tell it to cancel them. */
	const rejectAll = (reason: string, notifyParent: boolean) => {
		for (const [id, call] of pending) {
			pending.delete(id);
			if (notifyParent) sendToParent({ t: "cancel", id });
			call.reject(new Error(reason));
		}
	};
	const onDisconnect = () => rejectAll("Watcher main process disconnected", false);
	const attach = () => {
		if (attached) return;
		attached = true;
		process.on("message", onMessage);
		process.on("disconnect", onDisconnect);
	};
	const detach = () => {
		if (!attached) return;
		attached = false;
		process.off("message", onMessage);
		process.off("disconnect", onDisconnect);
		rejectAll("Watcher bridge shut down", true);
	};

	const callParent = (method: BridgeMethod, params: unknown, signal: AbortSignal | undefined): Promise<BridgeToolValue> => {
		if (linkMismatch) return Promise.reject(new Error(linkMismatch));
		attach();
		if (signal?.aborted) return Promise.reject(new Error("Aborted"));
		// Unique across extension reloads (a reloaded bridge must never reuse an in-flight id).
		const id = randomUUID();
		return new Promise<BridgeToolValue>((resolve, reject) => {
			const onAbort = () => {
				if (!pending.has(id)) return;
				pending.delete(id);
				sendToParent({ t: "cancel", id });
				reject(new Error("Aborted"));
			};
			pending.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			if (!sendToParent({ t: "call", id, method, params })) {
				pending.delete(id);
				signal?.removeEventListener("abort", onAbort);
				reject(new Error("pi-watcher main process is not connected"));
			}
		});
	};

	pi.registerTool({
		name: LIVE_MAIN_TOOLS_TOOL,
		label: "Live main tools",
		description:
			`Show the MAIN agent's currently running tools (read-only). Its transcript is ${JSON.stringify(config.mainSessionFile)}; read that literal path for history, not your own PI_SESSION_FILE. Pass toolCallId for one call's details, limit to cap the number of calls returned.`,
		promptSnippet: "Live view of the main agent's running/recent tool calls (read-only)",
		parameters: Type.Object({
			toolCallId: Type.Optional(Type.String({ description: "Return details for this main-session tool call id only" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum number of tool calls to return" })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		async execute(_toolCallId, params, signal) {
			if (!config.capabilities.liveMainTools) {
				return textResult({ text: "live_main_tools is not available in this watcher session.", isError: true });
			}
			return textResult(await callParent(LIVE_MAIN_TOOLS_TOOL, params ?? {}, signal));
		},
	});

	pi.registerTool({
		name: STEER_MAIN_TOOL,
		label: "Steer main agent",
		description:
			"Send a message into the MAIN pi agent. Use ONLY when the human explicitly asked you to tell, steer, or redirect the main agent — never on your own initiative. The human must approve (and may edit or decline) every message before it is delivered. mode 'steer' (default) interrupts after the main agent's current tool calls; 'followUp' waits until it finishes. If declined, do not retry unless the human asks again.",
		promptSnippet: "Send a human-approved message to the main agent (only when the human asks)",
		parameters: Type.Object({
			message: Type.String({ description: "Exact message for the main agent" }),
			mode: Type.Optional(
				Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
					description: "steer (default): deliver after current tool calls; followUp: deliver when main finishes",
				}),
			),
			rationale: Type.Optional(Type.String({ description: "One sentence for the human explaining why" })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			if (!config.capabilities.steerMain) {
				return textResult({ text: "steer_main is not available in this watcher session.", isError: true });
			}
			if (!params?.message || !String(params.message).trim()) {
				return textResult({ text: "steer_main requires a non-empty message.", isError: true });
			}
			return textResult(await callParent(STEER_MAIN_TOOL, params, signal));
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		attach();
		// Side-only tools must stay reachable even when inherited flags/settings narrowed the tool set.
		const active = pi.getActiveTools();
		const missing = BRIDGE_TOOL_NAMES.filter((name) => !active.includes(name));
		if (missing.length > 0) pi.setActiveTools([...active, ...missing]);

		let link: LinkStatus;
		const existing = findLink(ctx);
		if (!existing) {
			pi.appendEntry(LINK_ENTRY_TYPE, {
				mainSessionId: config.mainSessionId,
				mainSessionFile: config.mainSessionFile,
				linkedAt: new Date().toISOString(),
			});
			link = { status: "created" };
		} else if (existing.mainSessionId !== config.mainSessionId) {
			link = { status: "mismatch", foundMainSessionId: String(existing.mainSessionId) };
			linkMismatch = `This side session belongs to main session ${existing.mainSessionId}, not ${config.mainSessionId}`;
		} else {
			if (existing.mainSessionFile !== config.mainSessionFile) {
				pi.appendEntry(LINK_ENTRY_TYPE, {
					mainSessionId: config.mainSessionId,
					mainSessionFile: config.mainSessionFile,
					linkedAt: new Date().toISOString(),
				});
			}
			link = { status: "matched" };
		}
		sendToParent({
			t: "hello",
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			link,
			tools: pi.getActiveTools().filter((name) => (BRIDGE_TOOL_NAMES as readonly string[]).includes(name)),
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const options = event.systemPromptOptions as { sections?: Record<string, string> };
		options.sections = {
			...(options.sections ?? {}),
			[WATCHER_SECTION_KEY]: buildWatcherSystemPrompt({
				mainSessionFile: config.mainSessionFile,
				mainSessionId: config.mainSessionId,
				sideSessionFile: ctx.sessionManager.getSessionFile(),
				sideSessionId: ctx.sessionManager.getSessionId(),
				cwd: config.cwd,
				piDocsDir: config.piDocsDir,
				capabilities: config.capabilities,
				extraSystemPrompt: config.extraSystemPrompt,
			}),
		};
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		detach();
	});
}
