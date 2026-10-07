/**
 * Public types for the pi-watcher overlay UI.
 * Types plus the WATCHER_LIMITS constant. No runtime imports.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type WatcherRole = "user" | "assistant" | "tool";

export interface WatcherMessage {
	role: WatcherRole;
	text: string;
	id?: string;
	/** Epoch milliseconds, optional. */
	ts?: number;
}

/** Side-conversation model. Independent from the main agent's model. */
export interface WatcherModelRef {
	provider: string;
	id: string;
	name?: string;
}

export type WatcherSideStatus = "starting" | "idle" | "running" | "stopping" | "error";

export interface WatcherSideState {
	status: WatcherSideStatus;
	/** Short activity label, e.g. "reading src/a.ts". */
	activity?: string;
	error?: string;
}

export type WatcherMainStatus = "unknown" | "idle" | "running" | "aborting";

/** Compact live state of the MAIN agent (read-only for the UI). */
export interface WatcherMainState {
	status: WatcherMainStatus;
	/** Short activity label, e.g. tool name or "bash: npm test". */
	activity?: string;
	/** Main model label, display only. */
	model?: string;
	contextPercent?: number | null;
}

/** Currently streaming assistant text of the side conversation. */
export interface WatcherLiveState {
	text: string;
	/** True when the head was dropped to respect the live cap. */
	truncated: boolean;
}

/** Scroll position of the transcript. Preserved across close/open. */
export interface WatcherViewState {
	/** Stick to the newest content. */
	follow: boolean;
	/** First visible transcript line when not following. */
	top: number;
}

export interface WatcherSteeringRequest {
	id?: string;
	/** Proposed steering message for the main agent. */
	text: string;
	/** Why the watcher wants to steer (shown dimmed). */
	reason?: string;
}

export type WatcherSteeringDecision = { action: "send"; text: string; edited: boolean } | { action: "cancel" };

export interface WatcherPendingApproval {
	id: string;
	text: string;
	reason?: string;
	createdAt: number;
}

/** The single state object shared by parent and UI. Read via `store.state`; mutate via store methods. */
export interface WatcherUIState {
	messages: WatcherMessage[];
	/** Bumps on every change. */
	revision: number;
	live?: WatcherLiveState;
	side: WatcherSideState;
	main: WatcherMainState;
	model?: WatcherModelRef;
	draft: string;
	view: WatcherViewState;
	approvals: WatcherPendingApproval[];
	/** Overlay currently mounted. */
	open: boolean;
}

export type WatcherChangeKind = "messages" | "live" | "side" | "main" | "model" | "approval" | "view" | "ui";

export interface WatcherChange {
	kind: WatcherChangeKind;
	revision: number;
}

export type WatcherListener = (change: WatcherChange) => void;

/** Callbacks the parent implements; the UI never talks to the SDK/RPC session itself. */
export interface WatcherController {
	/** Called after the UI did `store.beginTurn(text)`. Stream results into the store. Throw to fail the turn. */
	submit(text: string): void | Promise<void>;
	/** Cancel the SIDE run only. Never abort the main agent here. */
	stop(): void | Promise<void>;
	/** Switch the side model. Throw/reject to refuse; the UI then keeps the old model. */
	setModel(model: WatcherModelRef): void | Promise<void>;
	/** Models for the picker. Default: ctx.modelRegistry.getAvailable(). */
	listModels?(): WatcherModelRef[] | Promise<WatcherModelRef[]>;
	/** Called once when the overlay closed (after cleanup). */
	onClose?(): void;
}

export type WatcherUIContext = Pick<ExtensionContext, "ui" | "mode" | "hasUI" | "modelRegistry">;

export interface WatcherUIResult {
	reason: "closed" | "aborted" | "unsupported" | "already-open";
}

/** Limits, exported for tests/tuning. */
export const WATCHER_LIMITS = {
	maxStoredMessages: 200,
	maxStoredMessageChars: 12_000,
	maxLiveChars: 20_000,
	maxRenderedMessages: 120,
	maxRenderedMessageChars: 12_000,
	maxToolLines: 4,
	maxApprovalChars: 8_000,
} as const;
