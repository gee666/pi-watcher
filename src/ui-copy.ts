/**
 * `/copy` support for the watcher overlay. Terminal selection cannot be limited to the overlay
 * column, so messages are copied to the system clipboard instead. Pure parsing/selection here;
 * the clipboard write itself is injected (Pi's copyToClipboard by default).
 */
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { messageNumbers } from "./ui-render.ts";
import type { WatcherLiveState, WatcherMessage } from "./ui-types.ts";

export const COPY_USAGE = "/copy [me] [n|all] — e.g. /copy (last Watcher reply), /copy 3 (Watcher #3), /copy me (your last), /copy me 2, /copy all";

export type CopySelection = { ok: true; text: string; label: string } | { ok: false; error: string };

const ME = new Set(["me", "my", "mine", "you", "user"]);
const AGENT = new Set(["agent", "watcher", "assistant", "reply", "w"]);

function clean(text: string): string {
	return stripTerminalSequences(text).replace(/\r\n?/g, "\n");
}

/** Resolve `/copy` arguments against the stored conversation. */
export function selectForCopy(messages: ReadonlyArray<WatcherMessage>, args: string, live?: WatcherLiveState): CopySelection {
	// Copy a snapshot of the visible reply without committing it to history.
	if (live?.text) {
		const prefix = live.truncated ? "… (earlier output not retained)\n" : "";
		messages = [...messages, { role: "assistant", text: prefix + live.text }];
	}
	const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	let role: "user" | "assistant" = "assistant";
	let which: "last" | "all" | number = "last";
	for (const w of words) {
		const n = /^#?(\d+)$/.exec(w);
		if (ME.has(w)) role = "user";
		else if (AGENT.has(w)) role = "assistant";
		else if (w === "all") which = "all";
		else if (w === "last") which = "last";
		else if (n) which = Number(n[1]);
		else return { ok: false, error: `Unknown /copy argument "${w}". Usage: ${COPY_USAGE}` };
	}

	if (which === "all") {
		const numbers = messageNumbers(messages);
		const parts: string[] = [];
		messages.forEach((m, i) => {
			const text = clean(m.text).trim();
			if (m.role === "user") parts.push(`## You #${numbers[i]}\n\n${text}`);
			else if (m.role === "assistant") parts.push(`## Watcher #${numbers[i]}\n\n${text}`);
			else parts.push(`> ⚙ ${text.split("\n").join("\n> ")}`);
		});
		if (!parts.length) return { ok: false, error: "Nothing to copy: the side conversation is empty." };
		return { ok: true, text: `${parts.join("\n\n")}\n`, label: "whole conversation" };
	}

	const own = messages.filter((m) => m.role === role);
	const name = role === "user" ? "You" : "Watcher";
	if (!own.length) return { ok: false, error: role === "user" ? "You have not sent any messages yet." : "No Watcher reply yet." };
	const index = which === "last" ? own.length : which;
	const msg = own[index - 1];
	if (!msg) return { ok: false, error: `No ${name} #${index}. Available: #1–#${own.length}.` };
	return { ok: true, text: clean(msg.text), label: `${name} #${index}` };
}
