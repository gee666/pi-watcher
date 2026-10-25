// Ordinary user extension: must be inherited by the side agent.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export default function (pi: ExtensionAPI) {
	const cliEntry = process.argv[1];
	pi.registerCommand("fixture-launch-subagent", {
		description: "launch Pi through argv[1]",
		handler: async (_args, ctx) => {
			let result;
			try {
				const child = spawn(process.execPath, [cliEntry,
					"--print", "--session-dir", join(ctx.cwd, "nested-sessions"), "--no-extensions", "--no-mcp",
					"--extension", fileURLToPath(new URL("./faux-provider.ts", import.meta.url)),
					"--provider", "faux", "--model", "faux-1", "nested hello",
				], { cwd: ctx.cwd, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
				child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
				await new Promise<void>((resolve, reject) => {
					child.once("error", reject);
					child.once("close", code => code === 0 ? resolve() : reject(new Error(`Pi exited ${code}: ${stderr}`)));
				});
				result = { cliEntry, stdout, stderr };
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
