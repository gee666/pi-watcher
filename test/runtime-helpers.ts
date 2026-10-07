import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "runtime");

export interface Sandbox {
	root: string;
	agentDir: string;
	cwd: string;
	sessionDir: string;
	mainSessionFile: string;
	mainSessionId: string;
	env: Record<string, string>;
	cleanup(): void;
}

/** Isolated agent dir + project + fake main session, using the offline faux provider fixture. */
export function createSandbox(mainSessionId = "11111111-2222-3333-4444-555555555555"): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "pw-rt-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const sessionDir = join(root, "side-sessions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify(
			{
				defaultProvider: "faux",
				defaultModel: "faux-1",
				quietStartup: true,
				extensions: [
					join(FIXTURES, "extensions", "faux-provider.ts"),
					join(FIXTURES, "extensions", "kept-ext.ts"),
					join(FIXTURES, "extensions", "other-ext.ts"),
					join(FIXTURES, "fake-watcher"),
				],
			},
			null,
			2,
		),
	);
	const mainSessionFile = join(cwd, "main-session.jsonl");
	writeFileSync(
		mainSessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: mainSessionId, timestamp: new Date().toISOString(), cwd })}\n`,
	);
	return {
		root,
		agentDir,
		cwd,
		sessionDir,
		mainSessionFile,
		mainSessionId,
		env: {
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
			FIXTURE_MAIN_FILE: mainSessionFile,
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
