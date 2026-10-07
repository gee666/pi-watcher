// Ordinary user extension: must be inherited by the side agent.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("kept-marker", { description: "inherited", handler: async () => {} });
	pi.registerCommand("fixture-reload", { description: "reload extensions", handler: async (_args, ctx) => ctx.reload() });
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "steer_main" && ctx.hasUI) {
			const ok = await ctx.ui.confirm("Allow steer_main?", "fixture permission gate");
			if (!ok) return { block: true, reason: "blocked by fixture gate" };
		}
		return undefined;
	});
}
