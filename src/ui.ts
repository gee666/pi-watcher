/**
 * pi-watcher overlay UI: persistent, scrollable side-conversation overlay.
 *
 * The parent owns the side-agent runtime and a WatcherStore;
 * this module renders the store, collects input, and calls WatcherController callbacks.
 * It never aborts the main agent and never performs steering itself.
 */
import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	fuzzyFilter,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	decodeKittyPrintable,
} from "@earendil-works/pi-tui";
import { COPY_USAGE, selectForCopy } from "./ui-copy.ts";
import { TranscriptRenderer, sanitizeText } from "./ui-render.ts";
import { WatcherStore } from "./ui-store.ts";
import {
	WATCHER_LIMITS,
	type WatcherController,
	type WatcherModelRef,
	type WatcherPendingApproval,
	type WatcherUIContext,
	type WatcherUIResult,
} from "./ui-types.ts";

export * from "./ui-types.ts";
export { WatcherStore, normalizeMessage, type EndTurnOptions, type WatcherStoreInit } from "./ui-store.ts";
export { TranscriptRenderer, sanitizeText, messageNumbers } from "./ui-render.ts";
export { selectForCopy, COPY_USAGE, type CopySelection } from "./ui-copy.ts";

export interface OpenWatcherUIOptions {
	store: WatcherStore;
	controller: WatcherController;
	/** Header title. Default "Watcher". */
	title?: string;
	/** Abort to close the overlay programmatically (e.g. on session shutdown). */
	signal?: AbortSignal;
	/** "model": open the side-model picker immediately (e.g. `/watcher model`). Never sends a prompt. */
	initialAction?: "model";
	/** Clipboard writer used by `/copy`. Default: Pi's copyToClipboard. */
	copyText?: (text: string) => Promise<void>;
}

type Mode = "chat" | "model" | "approval-edit";
type NoticeLevel = "info" | "warn" | "error";

const RENDER_THROTTLE_MS = 40;
const WHEEL_LINES = 3;

export const WATCHER_OVERLAY_OPTIONS = {
	anchor: "right-center",
	width: "50%",
	minWidth: 52,
	maxHeight: "100%",
	margin: { top: 1, bottom: 1, right: 0, left: 0 },
} as const;

export async function openWatcherUI(ctx: WatcherUIContext, options: OpenWatcherUIOptions): Promise<WatcherUIResult> {
	const { store, controller } = options;
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui?.notify?.("Watcher overlay needs the interactive terminal UI", "warning");
		return { reason: "unsupported" };
	}
	if (store.state.open) return { reason: "already-open" };
	if (options.signal?.aborted) return { reason: "aborted" };

	store.setOpen(true);
	try {
		const p = ctx.ui.custom<WatcherUIResult>(
			(tui, theme, _kb, done) => new WatcherOverlay(tui, theme, ctx, options, done),
			{ overlay: true, overlayOptions: { ...WATCHER_OVERLAY_OPTIONS, margin: { ...WATCHER_OVERLAY_OPTIONS.margin } } },
		);
		store.uiPromise = p;
		return await p;
	} finally {
		store.uiPromise = undefined;
		store.setOpen(false);
		try {
			controller.onClose?.();
		} catch {
			/* ignore */
		}
	}
}

/** Exported for tests. Prefer openWatcherUI. */
export class WatcherOverlay implements Component, Focusable {
	private tui: TUI;
	private theme: Theme;
	private ctx: WatcherUIContext;
	private store: WatcherStore;
	private controller: WatcherController;
	private title: string;
	private done: (r: WatcherUIResult) => void;
	private renderer: TranscriptRenderer;
	private copyText: (text: string) => Promise<void>;

	private _focused = false;
	private closed = false;
	private mode: Mode = "chat";
	private editor: Editor;
	private approvalEditor?: Editor;
	private approvalId?: string;
	private approvalSel = 1; // 0 send, 1 edit (default, no accidental send), 2 cancel

	private notice?: { text: string; level: NoticeLevel };
	private unsub?: () => void;
	private renderTimer?: ReturnType<typeof setTimeout>;
	private signal?: AbortSignal;
	private onAbort?: () => void;

	// layout memory for scroll math
	private lastTotal = 0;
	private lastViewport = 1;

	// model picker
	private pickerModels: WatcherModelRef[] = [];
	private pickerFilter = "";
	private pickerList?: SelectList;
	private pickerLoading = false;
	private pickerToken = 0;
	private modelChanging = false;

	constructor(
		tui: TUI,
		theme: Theme,
		ctx: WatcherUIContext,
		options: OpenWatcherUIOptions,
		done: (r: WatcherUIResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.ctx = ctx;
		this.store = options.store;
		this.controller = options.controller;
		this.title = options.title ?? "Watcher";
		this.done = done;
		this.renderer = new TranscriptRenderer(() => this.theme);
		this.copyText = options.copyText ?? copyToClipboard;

		this.editor = new Editor(tui, this.editorTheme(), { paddingX: 0 });
		if (this.store.state.draft) this.editor.setText(this.store.state.draft);
		this.editor.onChange = (t) => this.store.setDraft(t);
		this.editor.onSubmit = (t) => this.onEditorSubmit(t);

		this.unsub = this.store.subscribe((ev) => {
			if (ev.kind === "live") this.scheduleRender();
			else this.requestRender();
		});

		if (options.signal) {
			this.signal = options.signal;
			this.onAbort = () => this.close("aborted");
			options.signal.addEventListener("abort", this.onAbort, { once: true });
		}

		if (options.initialAction === "model") this.openPicker("");
	}

	// ---- Focusable -------------------------------------------------------------------------

	get focused(): boolean {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		this.syncEditorFocus();
	}

	private syncEditorFocus(): void {
		const chat = this.mode === "chat" && !this.currentApproval();
		this.editor.focused = this._focused && chat;
		if (this.approvalEditor) this.approvalEditor.focused = this._focused && this.mode === "approval-edit";
	}

	// ---- lifecycle -------------------------------------------------------------------------

	invalidate(): void {
		// Theme may have changed: pick up the live theme and drop embedded-ANSI caches.
		const t = this.ctx.ui?.theme;
		if (t) this.theme = t;
		this.renderer.invalidate();
		this.editor.invalidate();
		this.approvalEditor?.invalidate();
		this.pickerList?.invalidate();
	}

	dispose(): void {
		if (this.closed && !this.unsub) return;
		this.closed = true;
		this.pickerToken++;
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
		this.unsub?.();
		this.unsub = undefined;
		if (this.signal && this.onAbort) this.signal.removeEventListener("abort", this.onAbort);
		this.onAbort = undefined;
		// persist draft (scroll is persisted on every change)
		this.store.setDraft(this.editor.getText());
	}

	private close(reason: WatcherUIResult["reason"]): void {
		if (this.closed) return;
		this.dispose();
		this.done({ reason });
	}

	// ---- render scheduling -----------------------------------------------------------------

	private requestRender(): void {
		if (this.closed) return;
		this.tui.requestRender();
	}

	private scheduleRender(): void {
		if (this.closed || this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			this.requestRender();
		}, RENDER_THROTTLE_MS);
	}

	private setNotice(text: string, level: NoticeLevel = "info"): void {
		this.notice = { text, level };
		this.requestRender();
	}

	// ---- helpers ---------------------------------------------------------------------------

	private editorTheme(): EditorTheme {
		const th = () => this.theme;
		return {
			borderColor: (s) => th().fg("borderMuted", s),
			selectList: {
				selectedPrefix: (t) => th().fg("accent", t),
				selectedText: (t) => th().fg("accent", t),
				description: (t) => th().fg("muted", t),
				scrollInfo: (t) => th().fg("dim", t),
				noMatch: (t) => th().fg("warning", t),
			},
		};
	}

	private currentApproval(): WatcherPendingApproval | undefined {
		return this.store.state.approvals[0];
	}

	private sideBusy(): boolean {
		const s = this.store.state.side.status;
		return s === "running" || s === "stopping";
	}

	private modelLabel(m: WatcherModelRef | undefined): string {
		return m ? `${m.provider}/${m.id}` : "no model";
	}

	// ---- scrolling -------------------------------------------------------------------------

	private scrollBy(delta: number): void {
		const view = this.store.state.view;
		const maxTop = Math.max(0, this.lastTotal - this.lastViewport);
		let top = view.follow ? maxTop : Math.min(view.top, maxTop);
		top = Math.max(0, Math.min(maxTop, top + delta));
		this.store.setView({ follow: top >= maxTop, top });
		this.requestRender();
	}

	private scrollTo(where: "start" | "end"): void {
		if (where === "end") this.store.setView({ follow: true, top: 0 });
		else this.store.setView({ follow: false, top: 0 });
		this.requestRender();
	}

	private handleScrollKey(data: string): boolean {
		const page = Math.max(1, this.lastViewport - 1);
		if (matchesKey(data, Key.pageUp)) this.scrollBy(-page);
		else if (matchesKey(data, Key.pageDown)) this.scrollBy(page);
		else if (matchesKey(data, "shift+up")) this.scrollBy(-1);
		else if (matchesKey(data, "shift+down")) this.scrollBy(1);
		else if (matchesKey(data, "ctrl+home")) this.scrollTo("start");
		else if (matchesKey(data, "ctrl+end")) this.scrollTo("end");
		else return false;
		return true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			const dir = event.wheelDelta < 0 ? -1 : 1;
			this.scrollBy(dir * Math.max(1, Math.min(WHEEL_LINES, Math.abs(event.wheelDelta))));
			return { handled: true };
		}
		return undefined;
	}

	// ---- input -----------------------------------------------------------------------------

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.notice) {
			this.notice = undefined;
			this.requestRender();
		}
		if (this.mode === "model") {
			this.handlePickerInput(data);
		} else if (this.mode === "approval-edit") {
			this.handleApprovalEditInput(data);
		} else if (this.currentApproval()) {
			this.handleApprovalInput(data);
		} else {
			this.handleChatInput(data);
		}
		this.syncEditorFocus();
		this.requestRender();
	}

	private isClose(data: string): boolean {
		return matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c");
	}

	private handleChatInput(data: string): void {
		// Esc / Ctrl+C close the overlay only. They never reach the main agent's abort.
		if (this.isClose(data)) {
			this.close("closed");
			return;
		}
		if (this.handleScrollKey(data)) return;
		this.editor.handleInput(data);
	}

	// ---- chat submit & commands ------------------------------------------------------------

	private onEditorSubmit(raw: string): void {
		const text = raw.trim();
		if (!text) return;
		const cmd = /^\/(model|stop|help|copy)(?:\s+([\s\S]*))?$/.exec(text);
		if (cmd) {
			this.clearEditor();
			if (cmd[1] === "model") this.openPicker((cmd[2] ?? "").trim());
			else if (cmd[1] === "stop") this.doStop();
			else if (cmd[1] === "copy") this.doCopy(cmd[2] ?? "");
			else this.setNotice(`Enter send · Shift+Enter newline · PgUp/PgDn scroll · /model [filter] · /stop · ${COPY_USAGE} · Esc close (main agent untouched)`);
			return;
		}
		if (this.sideBusy()) {
			this.restoreDraft(raw);
			this.setNotice("Side agent is busy. Wait, or /stop to cancel it (draft kept).", "warn");
			return;
		}
		if (!this.store.state.model && this.store.state.side.status !== "starting") {
			this.restoreDraft(raw);
			this.setNotice("No side model selected. Use /model.", "warn");
			return;
		}
		this.editor.addToHistory(text);
		this.clearEditor();
		this.store.setView({ follow: true, top: 0 });
		this.store.beginTurn(text);
		this.guarded(() => this.controller.submit(text), (err) => {
			this.store.endTurn({ error: errMsg(err) });
		});
	}

	/** The Editor clears itself before onSubmit; put the text back when the submit is refused. */
	private restoreDraft(text: string): void {
		this.editor.setText(text);
		this.store.setDraft(text);
	}

	private clearEditor(): void {
		this.editor.setText("");
		this.store.setDraft("");
	}

	private doCopy(args: string): void {
		const sel = selectForCopy(this.store.state.messages, args);
		if (!sel.ok) {
			this.setNotice(sel.error, "warn");
			return;
		}
		this.guarded(
			async () => {
				await this.copyText(sel.text);
				if (!this.closed) this.setNotice(`Copied ${sel.label} (${sel.text.length.toLocaleString("en-US")} chars)`);
			},
			(err) => {
				if (!this.closed) this.setNotice(`Copy failed: ${errMsg(err)}`, "error");
			},
		);
	}

	private doStop(): void {
		const status = this.store.state.side.status;
		if (status !== "running") {
			this.setNotice(status === "stopping" ? "Already stopping the side agent…" : "Side agent is not running.", "info");
			return;
		}
		this.store.setSide({ status: "stopping" });
		this.guarded(() => this.controller.stop(), (err) => {
			this.store.setSide({ status: "running" });
			this.setNotice(`Stop failed: ${errMsg(err)}`, "error");
		});
	}

	/** Run a parent callback; sync throws and async rejections are routed to onError. */
	private guarded(fn: () => void | Promise<void>, onError: (e: unknown) => void): void {
		try {
			const r = fn();
			if (r && typeof (r as Promise<void>).then === "function") (r as Promise<void>).then(undefined, onError);
		} catch (e) {
			onError(e);
		}
	}

	// ---- model picker ----------------------------------------------------------------------

	private openPicker(filter: string): void {
		this.mode = "model";
		this.pickerFilter = filter;
		this.pickerList = undefined;
		this.pickerLoading = true;
		const token = ++this.pickerToken;
		const load = async (): Promise<WatcherModelRef[]> => {
			if (this.controller.listModels) return await this.controller.listModels();
			return this.ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
		};
		load().then(
			(models) => {
				if (this.closed || token !== this.pickerToken || this.mode !== "model") return;
				this.pickerModels = [...models].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
				this.pickerLoading = false;
				this.rebuildPicker();
				this.requestRender();
			},
			(err) => {
				if (this.closed || token !== this.pickerToken) return;
				this.mode = "chat";
				this.pickerLoading = false;
				this.setNotice(`Could not list models: ${errMsg(err)}`, "error");
			},
		);
		this.requestRender();
	}

	private rebuildPicker(): void {
		const cur = this.store.state.model;
		const matches = this.pickerFilter
			? fuzzyFilter(this.pickerModels, this.pickerFilter, (m) => `${m.provider}/${m.id} ${m.name ?? ""}`)
			: this.pickerModels;
		const items: SelectItem[] = matches.map((m) => {
			const idx = this.pickerModels.indexOf(m);
			const isCur = !!cur && cur.provider === m.provider && cur.id === m.id;
			return {
				value: String(idx),
				label: `${isCur ? "✓ " : ""}${m.provider}/${m.id}`,
				description: m.name && m.name !== m.id ? m.name : undefined,
			};
		});
		const th = () => this.theme;
		const list = new SelectList(items, 8, {
			selectedPrefix: (t) => th().fg("accent", t),
			selectedText: (t) => th().fg("accent", t),
			description: (t) => th().fg("muted", t),
			scrollInfo: (t) => th().fg("dim", t),
			noMatch: (t) => th().fg("warning", t),
		});
		list.onSelect = (item) => this.chooseModel(this.pickerModels[Number(item.value)]);
		list.onCancel = () => this.closePicker();
		this.pickerList = list;
	}

	private closePicker(): void {
		this.pickerToken++;
		this.mode = "chat";
		this.pickerLoading = false;
	}

	private handlePickerInput(data: string): void {
		if (this.isClose(data)) {
			this.closePicker();
			return;
		}
		if (this.handleScrollKey(data)) return;
		if (matchesKey(data, Key.backspace)) {
			if (this.pickerFilter) {
				this.pickerFilter = this.pickerFilter.slice(0, -1);
				this.rebuildPicker();
			}
			return;
		}
		const printable = decodeKittyPrintable(data) ?? (data >= " " && !data.startsWith("\x1b") && !/[\u0000-\u001f\u007f]/.test(data) ? data : undefined);
		if (printable && printable.length <= 8) {
			this.pickerFilter += printable;
			this.rebuildPicker();
			return;
		}
		this.pickerList?.handleInput(data);
	}

	private chooseModel(model: WatcherModelRef | undefined): void {
		if (!model) return;
		if (this.modelChanging) return;
		const cur = this.store.state.model;
		this.closePicker();
		if (cur && cur.provider === model.provider && cur.id === model.id) {
			this.setNotice(`Side model unchanged: ${this.modelLabel(model)}`);
			return;
		}
		this.modelChanging = true;
		this.guarded(
			async () => {
				try {
					await this.controller.setModel(model);
					this.store.setModel(model);
					this.setNotice(`Side model: ${this.modelLabel(model)}`);
				} finally {
					this.modelChanging = false;
				}
			},
			(err) => {
				this.modelChanging = false;
				this.setNotice(`Model change failed: ${errMsg(err)}`, "error");
			},
		);
	}

	// ---- steering approval -----------------------------------------------------------------

	private syncApprovalState(): void {
		const a = this.currentApproval();
		if (a?.id !== this.approvalId) {
			this.approvalId = a?.id;
			this.approvalSel = 1;
			if (this.mode === "approval-edit") this.mode = "chat";
		}
	}

	private handleApprovalInput(data: string): void {
		const a = this.currentApproval();
		if (!a) return;
		if (this.isClose(data)) {
			// Closes only the UI; the approval stays pending until the user answers.
			this.close("closed");
			return;
		}
		if (this.handleScrollKey(data)) return;
		if (matchesKey(data, Key.left) || matchesKey(data, "shift+tab") || matchesKey(data, Key.up)) {
			this.approvalSel = Math.max(0, this.approvalSel - 1);
		} else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
			this.approvalSel = Math.min(2, this.approvalSel + 1);
		} else if (data === "s" || data === "S") {
			this.approvalSel = 0; // select only; Enter confirms. Avoids accidental sends from stray typing.
		} else if (data === "e" || data === "E") {
			this.approvalSel = 1;
		} else if (data === "c" || data === "C") {
			this.approvalSel = 2;
		} else if (matchesKey(data, Key.enter)) {
			if (this.approvalSel === 0) {
				this.store.resolveApproval(a.id, { action: "send", text: a.text, edited: false });
			} else if (this.approvalSel === 2) {
				this.store.resolveApproval(a.id, { action: "cancel" });
				this.setNotice("Steering cancelled. Nothing was sent.");
			} else {
				this.startApprovalEdit(a);
			}
		}
	}

	private startApprovalEdit(a: WatcherPendingApproval): void {
		const ed = new Editor(this.tui, this.editorTheme(), { paddingX: 0 });
		ed.borderColor = (s) => this.theme.fg("warning", s);
		ed.setText(a.text);
		ed.onSubmit = (t) => {
			const text = t.trim();
			if (!text) {
				this.setNotice("Steering text is empty. Esc to go back, or type a message.", "warn");
				return;
			}
			const cur = this.currentApproval();
			if (!cur || cur.id !== a.id) return;
			this.mode = "chat";
			this.approvalEditor = undefined;
			this.store.resolveApproval(a.id, { action: "send", text, edited: text !== a.text });
		};
		this.approvalEditor = ed;
		this.mode = "approval-edit";
	}

	private handleApprovalEditInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.mode = "chat"; // back to Send/Edit/Cancel
			this.approvalEditor = undefined;
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.close("closed");
			return;
		}
		if (this.handleScrollKey(data)) return;
		this.approvalEditor?.handleInput(data);
	}

	// ---- render ----------------------------------------------------------------------------

	render(width: number): string[] {
		if (this.closed) return [];
		const theme = this.theme;
		const state = this.store.state;
		this.syncApprovalState();
		this.syncEditorFocus();

		const w = Math.max(12, width);
		const inner = w - 2;
		const rows = Math.max(4, this.tui.terminal.rows);
		const H = Math.max(4, rows - 2);
		const compact = H < 14;
		const b = (s: string) => theme.fg("borderAccent", s);
		const frame = (s: string) => `${b("│")}${truncateToWidth(s, inner, "", true)}${b("│")}`;
		const rule = (l: string, r: string, label = "", right = "") => {
			const lw = visibleWidth(label);
			const rw = visibleWidth(right);
			const fill = inner - lw - rw;
			if (fill < 1) return b(l) + truncateToWidth(label, inner, "…", true) + b(r);
			return b(l) + label + b("─".repeat(fill)) + right + b(r);
		};

		// --- header + status
		const head: string[] = [];
		const modelTxt = theme.fg(state.model ? "muted" : "warning", this.modelLabel(state.model));
		head.push(rule("╭", "╮", ` ${theme.fg("accent", theme.bold(this.title))} `, ` ${modelTxt} `));
		if (!compact) head.push(frame(` ${this.sideStatusLine()}`));
		head.push(frame(` ${this.mainStatusLine()}`));

		// --- bottom block
		const bottom = this.renderBottom(inner, H, compact, frame);

		// --- viewport
		const fixed = head.length + 1 /* sep */ + bottom.length + 1 /* bottom border */;
		const vp = Math.max(1, H - fixed);
		const all = this.renderer.build(inner - 1, state);
		const total = all.length;
		const maxTop = Math.max(0, total - vp);
		const view = state.view;
		let top = view.follow ? maxTop : Math.min(view.top, maxTop);
		if (!view.follow && top >= maxTop) top = maxTop;
		this.lastTotal = total;
		this.lastViewport = vp;

		const body: string[] = [];
		if (total === 0) {
			body.push(frame(theme.fg("dim", " Side conversation is empty. Ask a question below.")));
			for (let i = 1; i < vp; i++) body.push(frame(""));
		} else {
			const slice = all.slice(top, top + vp);
			// bottom-align short transcripts
			for (let i = slice.length; i < vp; i++) body.push(frame(""));
			for (const l of slice) body.push(frame(` ${l}`));
		}

		const above = top;
		const below = Math.max(0, total - (top + vp));
		let hint = "";
		if (above > 0 || below > 0) {
			hint = theme.fg("dim", ` ${above > 0 ? `↑${above}` : ""}${above > 0 && below > 0 ? " " : ""}${below > 0 ? `↓${below}` : ""} `);
		}

		const out = [...head, rule("├", "┤", "", hint), ...body, ...bottom, rule("╰", "╯")];
		return out.length > H ? out.slice(0, H) : out;
	}

	private sideStatusLine(): string {
		const th = this.theme;
		const s = this.store.state.side;
		const color = s.status === "starting" || s.status === "running" || s.status === "stopping" ? "warning" : s.status === "error" ? "error" : "success";
		let txt = `${th.fg("muted", "side")} ${th.fg(color, "●")} ${th.fg(color, s.status)}`;
		if (s.activity && (s.status === "running" || s.status === "stopping")) txt += th.fg("dim", ` · ${oneLine(s.activity, 40)}`);
		if (s.status === "error" && s.error) txt += th.fg("error", ` · ${oneLine(s.error, 60)}`);
		return txt;
	}

	private mainStatusLine(): string {
		const th = this.theme;
		const m = this.store.state.main;
		const color = m.status === "running" ? "accent" : m.status === "aborting" ? "warning" : m.status === "idle" ? "success" : "dim";
		const glyph = m.status === "running" ? "●" : m.status === "unknown" ? "○" : m.status === "aborting" ? "◐" : "●";
		let txt = `${th.fg("muted", "main")} ${th.fg(color, glyph)} ${th.fg(color, m.status)}`;
		if (m.activity && m.status !== "idle") txt += th.fg("dim", ` · ${oneLine(m.activity, 40)}`);
		if (typeof m.contextPercent === "number") txt += th.fg("dim", ` · ctx ${Math.round(m.contextPercent)}%`);
		if (m.model) txt += th.fg("dim", ` · ${oneLine(m.model, 28)}`);
		return txt;
	}

	private hintLine(inner: number): string {
		const th = this.theme;
		let txt: string;
		if (this.mode === "model") txt = "type filter · ↑↓ · Enter select · Esc back";
		else if (this.mode === "approval-edit") txt = "Enter send edited · Shift+Enter newline · Esc back";
		else if (this.currentApproval()) txt = "←/→ select · Enter confirm · Esc close (stays pending)";
		else if (inner >= 76) txt = "Enter send · ⇧Enter newline · PgUp/PgDn scroll · /model · /copy · /stop · Esc close";
		else if (inner >= 50) txt = "Enter send · PgUp/PgDn · /model · /copy · /stop · Esc";
		else txt = "Enter send · Esc close";
		return th.fg("dim", ` ${txt}`);
	}

	private renderBottom(inner: number, H: number, compact: boolean, frame: (s: string) => string): string[] {
		const th = this.theme;
		const lines: string[] = [];

		if (this.notice) {
			const color = this.notice.level === "error" ? "error" : this.notice.level === "warn" ? "warning" : "accent";
			const { text } = sanitizeText(this.notice.text, 600);
			const wrapped = wrapTextWithAnsi(text, Math.max(1, inner - 3)).slice(0, 5);
			wrapped.forEach((l, i) => lines.push(frame(` ${th.fg(color, i === 0 ? "! " : "  ")}${th.fg(color, l)}`)));
		}

		const approval = this.currentApproval();
		const editorCap = Math.max(3, Math.min(8, Math.floor(H * 0.35)));

		if (this.mode === "model") {
			lines.push(frame(` ${th.fg("accent", th.bold("Select side model"))} ${th.fg("dim", "(independent of main)")}`));
			lines.push(frame(` ${th.fg("muted", "filter:")} ${this.pickerFilter}${th.fg("dim", "▏")}`));
			if (this.pickerLoading) lines.push(frame(th.fg("dim", "  loading models…")));
			else if (this.pickerList) {
				const maxVis = Math.max(3, Math.min(10, H - 12));
				const lw = Math.max(1, inner - 2);
				for (const l of this.pickerList.render(lw).slice(0, maxVis + 2)) lines.push(frame(` ${l}`));
			}
		} else if (this.mode === "approval-edit" && this.approvalEditor) {
			lines.push(frame(` ${th.fg("warning", th.bold("Edit steering message for main agent"))}`));
			for (const l of this.capEditorLines(this.approvalEditor.render(inner), editorCap)) lines.push(frame(l));
		} else if (approval) {
			for (const l of this.renderApproval(approval, inner, H)) lines.push(frame(l));
		} else {
			if (this.sideBusy() && !compact) {
				lines.push(frame(th.fg("dim", " side is running – you can draft; Enter is refused until it finishes, /stop cancels")));
			}
			for (const l of this.capEditorLines(this.editor.render(inner), editorCap)) lines.push(frame(l));
		}

		if (!compact) lines.push(frame(this.hintLine(inner)));
		return lines;
	}

	private capEditorLines(lines: string[], cap: number): string[] {
		if (lines.length <= cap) return lines;
		// keep top border, last (cap-2) content lines, bottom border
		const top = lines[0]!;
		const bottom = lines[lines.length - 1]!;
		const content = lines.slice(1, -1);
		return [top, ...content.slice(Math.max(0, content.length - (cap - 2))), bottom];
	}

	private renderApproval(a: WatcherPendingApproval, inner: number, H: number): string[] {
		const th = this.theme;
		const out: string[] = [];
		const maxText = Math.max(2, Math.min(8, H - 14));
		out.push(` ${th.fg("warning", th.bold("⚠ Steer main agent?"))} ${th.fg("dim", "nothing is sent until you choose Send")}`);
		const { text } = sanitizeText(a.text, WATCHER_LIMITS.maxApprovalChars);
		const wrapped = wrapTextWithAnsi(text, Math.max(1, inner - 4));
		wrapped.slice(0, maxText).forEach((l) => out.push(`   ${l}`));
		if (wrapped.length > maxText) out.push(th.fg("dim", `   … +${wrapped.length - maxText} more line(s) (Edit to see all)`));
		if (a.reason) {
			const r = wrapTextWithAnsi(sanitizeText(a.reason, 400).text, Math.max(1, inner - 10)).slice(0, 2);
			r.forEach((l, i) => out.push(th.fg("dim", ` ${i === 0 ? "why: " : "     "}${l}`)));
		}
		const btn = (i: number, label: string, color: "success" | "accent" | "error") =>
			this.approvalSel === i
				? th.bg("selectedBg", th.fg(color, th.bold(`[ ${label} ]`)))
				: th.fg("muted", `[ ${label} ]`);
		const queued = this.store.state.approvals.length - 1;
		out.push(
			` ${btn(0, "Send", "success")} ${btn(1, "Edit", "accent")} ${btn(2, "Cancel", "error")}` +
				(queued > 0 ? th.fg("dim", `  +${queued} queued`) : ""),
		);
		return out;
	}
}

function oneLine(s: string, max: number): string {
	const t = sanitizeText(s, max * 4).text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message || e.name;
	return typeof e === "string" ? e : "unknown error";
}
