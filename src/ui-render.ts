/**
 * Transcript line builder for the watcher overlay. Pure (no TUI instance); caches per message and width.
 */
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { WATCHER_LIMITS, type WatcherLiveState, type WatcherMessage, type WatcherUIState } from "./ui-types.ts";

/** Remove terminal escape sequences/control chars (except \n) and cap length. */
export function sanitizeText(text: string, maxChars: number): { text: string; cut: boolean } {
	let cut = false;
	if (text.length > maxChars) {
		text = text.slice(0, maxChars);
		cut = true;
	}
	let out = stripTerminalSequences(text);
	out = out.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
	// eslint-disable-next-line no-control-regex
	out = out.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
	return { text: out, cut };
}

function fit(lines: string[], width: number): string[] {
	for (let i = 0; i < lines.length; i++) {
		if (visibleWidth(lines[i]!) > width) lines[i] = truncateToWidth(lines[i]!, width, "…");
	}
	return lines;
}

interface MsgCacheEntry {
	width: number;
	number: number;
	lines: string[];
}

/**
 * 1-based per-role number of each message (user and assistant counted separately; tool entries get 0).
 * Shown as "You #n" / "Watcher #n" and used by `/copy`.
 */
export function messageNumbers(messages: ReadonlyArray<WatcherMessage>): number[] {
	let user = 0;
	let assistant = 0;
	return messages.map((m) => (m.role === "user" ? ++user : m.role === "assistant" ? ++assistant : 0));
}

export class TranscriptRenderer {
	private getTheme: () => Theme;
	private msgCache = new WeakMap<WatcherMessage, MsgCacheEntry>();
	private all?: { width: number; messages: WatcherMessage[]; length: number; first?: WatcherMessage; last?: WatcherMessage; lines: string[] };
	private liveCache?: { width: number; text: string; truncated: boolean; lines: string[] };

	constructor(getTheme: () => Theme) {
		this.getTheme = getTheme;
	}

	invalidate(): void {
		this.msgCache = new WeakMap();
		this.all = undefined;
		this.liveCache = undefined;
	}

	/** Full transcript (history + live) as lines for `width`. */
	build(width: number, state: Pick<WatcherUIState, "messages" | "live">): string[] {
		width = Math.max(8, width);
		const history = this.buildHistory(width, state.messages);
		if (!state.live) return history;
		return history.concat(this.buildLive(width, state.live));
	}

	private buildHistory(width: number, messages: WatcherMessage[]): string[] {
		const total = messages.length;
		const start = Math.max(0, total - WATCHER_LIMITS.maxRenderedMessages);
		const first = messages[start];
		const last = messages[total - 1];
		const c = this.all;
		if (c && c.width === width && c.messages === messages && c.length === total && c.first === first && c.last === last) {
			return c.lines;
		}
		const theme = this.getTheme();
		const lines: string[] = [];
		if (start > 0) lines.push(theme.fg("dim", truncateToWidth(`… ${start} earlier message${start === 1 ? "" : "s"} not shown`, width, "…")), "");
		const numbers = messageNumbers(messages);
		for (let i = start; i < total; i++) {
			const m = messages[i]!;
			const number = numbers[i]!;
			let entry = this.msgCache.get(m);
			if (!entry || entry.width !== width || entry.number !== number) {
				entry = { width, number, lines: this.renderMessage(m, width, number) };
				this.msgCache.set(m, entry);
			}
			for (const l of entry.lines) lines.push(l);
		}
		this.all = { width, messages, length: total, first, last, lines };
		return lines;
	}

	private renderMessage(m: WatcherMessage, width: number, number: number): string[] {
		const theme = this.getTheme();
		const { text, cut } = sanitizeText(m.text, WATCHER_LIMITS.maxRenderedMessageChars);
		const note = cut ? [theme.fg("dim", "  … (message truncated)")] : [];
		const out: string[] = [];
		if (m.role === "user") {
			out.push(theme.fg("accent", theme.bold("You")) + theme.fg("dim", ` #${number}`));
			for (const l of wrapTextWithAnsi(text, Math.max(1, width - 2))) out.push(`  ${l}`);
		} else if (m.role === "assistant") {
			out.push(theme.fg("success", theme.bold("Watcher")) + theme.fg("dim", ` #${number}`));
			const md = new Markdown(text, 1, 0, getMarkdownTheme());
			for (const l of md.render(width)) out.push(l);
		} else {
			const src = text.split("\n");
			const shown = src.slice(0, WATCHER_LIMITS.maxToolLines);
			shown.forEach((l, i) => out.push(theme.fg("dim", `${i === 0 ? "⚙ " : "  "}${l}`)));
			if (src.length > shown.length) out.push(theme.fg("dim", `  … +${src.length - shown.length} more line(s)`));
		}
		for (const n of note) out.push(n);
		out.push("");
		return fit(out, width);
	}

	private buildLive(width: number, live: WatcherLiveState): string[] {
		const c = this.liveCache;
		if (c && c.width === width && c.text.length === live.text.length && c.truncated === live.truncated && c.text === live.text) {
			return c.lines;
		}
		const theme = this.getTheme();
		const out: string[] = [theme.fg("warning", theme.bold("Watcher ▍"))];
		if (live.truncated) out.push(theme.fg("dim", "  … earlier output hidden"));
		const { text } = sanitizeText(live.text, WATCHER_LIMITS.maxLiveChars);
		for (const l of wrapTextWithAnsi(text, Math.max(1, width - 2))) out.push(`  ${l}`);
		out.push("");
		const lines = fit(out, width);
		this.liveCache = { width, text: live.text, truncated: live.truncated, lines };
		return lines;
	}
}
