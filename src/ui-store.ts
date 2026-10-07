/**
 * WatcherStore: single observable state object shared by the parent (SDK/RPC session owner)
 * and the overlay UI. Plain data, no pi runtime dependencies.
 */
import {
	WATCHER_LIMITS,
	type WatcherChange,
	type WatcherChangeKind,
	type WatcherListener,
	type WatcherMainState,
	type WatcherMessage,
	type WatcherModelRef,
	type WatcherRole,
	type WatcherSideState,
	type WatcherSteeringDecision,
	type WatcherSteeringRequest,
	type WatcherUIState,
	type WatcherViewState,
} from "./ui-types.ts";

export interface WatcherStoreInit {
	/** Persisted conversation. Entries with an unknown role are dropped. */
	messages?: ReadonlyArray<{ role: string; text: unknown; id?: string; ts?: number }>;
	model?: WatcherModelRef;
	main?: Partial<WatcherMainState>;
	draft?: string;
}

export interface EndTurnOptions {
	/** Final assistant text. Defaults to the accumulated live text. */
	message?: string;
	error?: string;
	/** Turn was cancelled via /stop; keeps partial live text as assistant message. */
	aborted?: boolean;
}

const ROLES: ReadonlySet<string> = new Set(["user", "assistant", "tool"]);

export function normalizeMessage(raw: { role: string; text: unknown; id?: string; ts?: number }): WatcherMessage | undefined {
	if (!raw || !ROLES.has(raw.role)) return undefined;
	let text = typeof raw.text === "string" ? raw.text : raw.text == null ? "" : String(raw.text);
	if (text.length > WATCHER_LIMITS.maxStoredMessageChars) {
		text = `${text.slice(0, WATCHER_LIMITS.maxStoredMessageChars)}\n… (truncated)`;
	}
	const msg: WatcherMessage = { role: raw.role as WatcherRole, text };
	if (raw.id !== undefined) msg.id = raw.id;
	if (raw.ts !== undefined) msg.ts = raw.ts;
	return msg;
}

interface Pending {
	resolve: (d: WatcherSteeringDecision) => void;
	cleanup?: () => void;
}

export class WatcherStore {
	readonly state: WatcherUIState;
	private listeners = new Set<WatcherListener>();
	private pending = new Map<string, Pending>();
	private idCounter = 0;
	private disposed = false;
	/** Promise of the currently mounted overlay (managed by openWatcherUI). */
	uiPromise: Promise<unknown> | undefined;

	constructor(init: WatcherStoreInit = {}) {
		this.state = {
			messages: [],
			revision: 0,
			side: { status: "idle" },
			main: { status: "unknown", ...init.main },
			model: init.model ? { ...init.model } : undefined,
			draft: init.draft ?? "",
			view: { follow: true, top: 0 },
			approvals: [],
			open: false,
		};
		if (init.messages) this.setMessages(init.messages, true);
	}

	// ---- observers -------------------------------------------------------------------------

	subscribe(listener: WatcherListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(kind: WatcherChangeKind): void {
		this.state.revision++;
		if (this.disposed || this.listeners.size === 0) return;
		const change: WatcherChange = { kind, revision: this.state.revision };
		for (const l of [...this.listeners]) {
			try {
				l(change);
			} catch {
				/* observer errors must not break the store */
			}
		}
	}

	// ---- conversation ----------------------------------------------------------------------

	setMessages(list: NonNullable<WatcherStoreInit["messages"]>, silent = false): void {
		const out: WatcherMessage[] = [];
		for (const raw of list) {
			const m = normalizeMessage(raw);
			if (m) out.push(m);
		}
		this.state.messages = out.length > WATCHER_LIMITS.maxStoredMessages ? out.slice(-WATCHER_LIMITS.maxStoredMessages) : out;
		if (!silent) this.emit("messages");
	}

	addMessage(role: WatcherRole, text: string, id?: string): WatcherMessage | undefined {
		const m = normalizeMessage({ role, text, id, ts: Date.now() });
		if (!m) return undefined;
		const msgs = this.state.messages;
		msgs.push(m);
		if (msgs.length > WATCHER_LIMITS.maxStoredMessages) msgs.splice(0, msgs.length - WATCHER_LIMITS.maxStoredMessages);
		this.emit("messages");
		return m;
	}

	beginTurn(text: string): void {
		this.addMessage("user", text);
		this.state.live = undefined;
		this.state.side = { status: "running" };
		this.emit("side");
	}

	appendLive(delta: string): void {
		if (!delta) return;
		const live = this.state.live ?? { text: "", truncated: false };
		let next = live.text + delta;
		let truncated = live.truncated;
		if (next.length > WATCHER_LIMITS.maxLiveChars) {
			next = next.slice(next.length - WATCHER_LIMITS.maxLiveChars);
			truncated = true;
		}
		this.state.live = { text: next, truncated };
		this.emit("live");
	}

	/** Replace the live text (snapshot-style streaming). */
	setLive(text: string | undefined): void {
		if (text === undefined) {
			this.state.live = undefined;
		} else if (text.length > WATCHER_LIMITS.maxLiveChars) {
			this.state.live = { text: text.slice(text.length - WATCHER_LIMITS.maxLiveChars), truncated: true };
		} else {
			this.state.live = { text, truncated: false };
		}
		this.emit("live");
	}

	endTurn(opts: EndTurnOptions = {}): void {
		const live = this.state.live;
		const text = opts.message ?? live?.text ?? "";
		this.state.live = undefined;
		if (text.trim()) {
			const note = !opts.message && live?.truncated ? "… (earlier output not retained)\n" : "";
			const suffix = opts.aborted ? "\n\n_(stopped)_" : "";
			this.addMessage("assistant", `${note}${text}${suffix}`);
		}
		this.state.side = opts.error ? { status: "error", error: opts.error } : { status: "idle" };
		this.emit("side");
	}

	setSide(patch: Partial<WatcherSideState>): void {
		this.state.side = { ...this.state.side, ...patch };
		this.emit("side");
	}

	setMain(patch: Partial<WatcherMainState>): void {
		this.state.main = { ...this.state.main, ...patch };
		this.emit("main");
	}

	setModel(model: WatcherModelRef | undefined): void {
		this.state.model = model ? { ...model } : undefined;
		this.emit("model");
	}

	// ---- UI-written, silent state ----------------------------------------------------------

	setDraft(text: string): void {
		this.state.draft = text;
	}

	setView(view: WatcherViewState): void {
		this.state.view = { follow: view.follow, top: Math.max(0, Math.floor(view.top)) };
	}

	setOpen(open: boolean): void {
		if (this.state.open === open) return;
		this.state.open = open;
		this.emit("ui");
	}

	// ---- steering approval -----------------------------------------------------------------

	/**
	 * Queue a steering proposal. Resolves ONLY when the user decides in the overlay (or the request is
	 * cancelled via cancelApproval / signal / dispose, which resolve `{action:"cancel"}`).
	 * The store itself never performs the steering.
	 */
	requestSteeringApproval(req: WatcherSteeringRequest, signal?: AbortSignal): Promise<WatcherSteeringDecision> {
		if (this.disposed || signal?.aborted) return Promise.resolve({ action: "cancel" });
		const id = req.id ?? `steer-${++this.idCounter}-${Date.now().toString(36)}`;
		if (this.pending.has(id)) return Promise.resolve({ action: "cancel" });
		let text = String(req.text ?? "");
		if (text.length > WATCHER_LIMITS.maxApprovalChars) text = text.slice(0, WATCHER_LIMITS.maxApprovalChars);
		return new Promise<WatcherSteeringDecision>((resolve) => {
			const entry: Pending = { resolve };
			if (signal) {
				const onAbort = () => this.resolveApproval(id, { action: "cancel" });
				signal.addEventListener("abort", onAbort, { once: true });
				entry.cleanup = () => signal.removeEventListener("abort", onAbort);
			}
			this.pending.set(id, entry);
			this.state.approvals.push({ id, text, reason: req.reason, createdAt: Date.now() });
			this.emit("approval");
		});
	}

	/** Used by the UI. Ignored if the id is not pending. */
	resolveApproval(id: string, decision: WatcherSteeringDecision): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		this.pending.delete(id);
		entry.cleanup?.();
		const i = this.state.approvals.findIndex((a) => a.id === id);
		if (i >= 0) this.state.approvals.splice(i, 1);
		this.emit("approval");
		entry.resolve(decision);
		return true;
	}

	cancelApproval(id: string): boolean {
		return this.resolveApproval(id, { action: "cancel" });
	}

	dispose(): void {
		if (this.disposed) return;
		for (const id of [...this.pending.keys()]) this.resolveApproval(id, { action: "cancel" });
		this.disposed = true;
		this.listeners.clear();
	}
}
