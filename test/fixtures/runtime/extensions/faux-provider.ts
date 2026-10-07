// Scripted offline model provider for runtime integration tests.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function lastUserText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user") return typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join("");
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	let sideSessionFile = "<unset>";
	let sideSessionId = "<unset>";
	pi.on("session_start", (_event, ctx) => {
		sideSessionFile = ctx.sessionManager.getSessionFile() ?? "<unset>";
		sideSessionId = ctx.sessionManager.getSessionId();
	});
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-2" }] });
	const respond = (context: any) => {
		const messages = context.messages as any[];
		const last = messages[messages.length - 1];
		if (last?.role === "toolResult") {
			const text = last.content.map((c: any) => c.text ?? "").join("");
			return fauxAssistantMessage(`TOOL ${last.toolName} ${last.isError ? "ERROR" : "OK"}: ${text}`);
		}
		const prompt = lastUserText(messages);
		if (prompt.startsWith("LIVE")) return fauxAssistantMessage(fauxToolCall("live_main_tools", { limit: 3 }));
		if (prompt.startsWith("STEER")) {
			return fauxAssistantMessage(fauxToolCall("steer_main", { message: "please stop", mode: "steer", rationale: "asked" }));
		}
		if (prompt.startsWith("SYSPROMPT")) {
			const all = JSON.stringify(messages);
			const ok = all.includes("You are Watcher, the SIDE AGENT") &&
				all.includes(process.env.FIXTURE_MAIN_FILE ?? "<unset>") &&
				all.includes(sideSessionFile) && all.includes(sideSessionId) &&
				all.includes("PI_SESSION_FILE and PI_SESSION_ID") &&
				all.includes("YOUR Watcher session, NOT the MAIN agent") &&
				all.includes("The MAIN path above is authoritative");
			return fauxAssistantMessage(ok ? "SYSPROMPT_OK" : "SYSPROMPT_MISSING");
		}
		return fauxAssistantMessage(`echo: ${prompt}`);
	};
	const responses = Array.from({ length: 200 }, () => respond);
	faux.setResponses(responses as any);
	pi.registerProvider(faux.provider);
}
