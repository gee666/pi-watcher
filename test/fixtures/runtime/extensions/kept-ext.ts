// Ordinary user extension: must be inherited by the side agent.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export default function (pi: ExtensionAPI) {
	const cliEntry = process.argv[1];
	pi.registerCommand("fixture-launch-subagent", {
		description: "launch Pi through argv[1]",
		handler: async (_args, ctx) => {
			let result;
			try {
				const pending = promisify(execFile)(process.execPath, [cliEntry,
					"--print", "--no-session", "--no-extensions", "--no-mcp",
					"--extension", fileURLToPath(new URL("./faux-provider.ts", import.meta.url)),
					"--provider", "faux", "--model", "faux-1", "nested hello",
				], { cwd: ctx.cwd, timeout: 20_000, encoding: "utf8" });
				pending.child.stdin?.end();
				result = { cliEntry, ...await pending };
			} catch (error) {
				result = { cliEntry, error: String(error) };
			}
			writeFileSync(join(ctx.cwd, "subagent-result.json"), JSON.stringify(result));
		},
	});
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
