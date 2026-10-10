/**
 * End-to-end tests: real `pi --mode rpc` child from the installed pi package, isolated agent dir,
 * offline faux provider fixture. Skipped when pi cannot be located (set PI_PACKAGE_DIR).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { locatePi } from "../src/runtime-args.ts";
import {
	messagesToTranscript,
	type SteerMainRequest,
	WatcherRuntime,
	WatcherRuntimeError,
	type WatcherRuntimeEvent,
	type WatcherRuntimeOptions,
} from "../src/runtime.ts";
import { createSandbox, FIXTURES, type Sandbox } from "./runtime-helpers.ts";

let piAvailable = true;
try {
	locatePi();
} catch {
	piAvailable = false;
}

const TIMEOUT = 60_000;

function baseOptions(sb: Sandbox, extra: Partial<WatcherRuntimeOptions> = {}): WatcherRuntimeOptions {
	return {
		cwd: sb.cwd,
		mainSessionFile: sb.mainSessionFile,
		mainSessionId: sb.mainSessionId,
		sessionDir: sb.sessionDir,
		watcherRoot: join(FIXTURES, "fake-watcher"),
		excludedExtensions: ["other-ext"],
		inheritCliArgs: false,
		env: sb.env,
		startupTimeoutMs: TIMEOUT,
		...extra,
	};
}

async function ask(rt: WatcherRuntime, text: string): Promise<string | null> {
	assert.equal(await rt.prompt(text), "started");
	await rt.waitForSettled({ timeoutMs: TIMEOUT });
	return rt.getLastAssistantText();
}

describe("WatcherRuntime (integration)", { skip: !piAvailable && "pi package not found" }, () => {
	let sb: Sandbox;
	before(() => {
		sb = createSandbox();
	});
	after(() => sb?.cleanup());

	test("starts without prompting, excludes watcher + configured extensions, inherits others, bridges tools", { timeout: TIMEOUT * 3 }, async () => {
		const events: WatcherRuntimeEvent[] = [];
		const steerRequests: SteerMainRequest[] = [];
		const rt = new WatcherRuntime();
		rt.subscribe((e) => events.push(e));
		try {
			const info = await rt.start(
				baseOptions(sb, {
					model: { provider: "faux", modelId: "faux-2" },
					liveMainTools: ({ params, mainSessionId }) => ({ text: `live:${mainSessionId}:${JSON.stringify(params)}`, details: { n: 1 } }),
					steerMain: (req) => {
						steerRequests.push(req);
						return { approved: true };
					},
					onUiRequest: (req) => (req.method === "confirm" ? { confirmed: true } : { cancelled: true }),
				}),
			);
			assert.equal(rt.status, "ready");
			assert.equal(info.sideSessionId, `watcher-${sb.mainSessionId}`);
			assert.equal(info.link, "created");
			assert.deepEqual([...info.bridgeTools].sort(), ["live_main_tools", "steer_main"]);
			assert.deepEqual(info.model, { provider: "faux", id: "faux-2" });
			const excludedPaths = info.excludedExtensions.map((e) => e.path).join("\n");
			assert.match(excludedPaths, /fake-watcher/);
			assert.match(excludedPaths, /other-ext\.ts/);

			// No automatic prompt: the side session has no user/assistant messages.
			const messages = await rt.getMessages();
			assert.equal(messages.filter((m) => m.role === "user" || m.role === "assistant").length, 0);

			const commands = (await rt.getCommands()).map((c) => c.name);
			assert.ok(commands.includes("kept-marker"), "ordinary extension inherited");
			assert.ok(!commands.includes("fake-watcher-marker"), "watcher excluded");
			assert.ok(!commands.includes("other-marker"), "configured exclusion applied");
			assert.ok(commands.includes("mcp"), "built-in MCP extension inherited");

			const models = (await rt.getAvailableModels()).map((m) => `${m.provider}/${m.id}`);
			assert.ok(models.includes("faux/faux-1") && models.includes("faux/faux-2"));
			assert.equal((await rt.getState()).model?.id, "faux-2");

			assert.equal(await ask(rt, "hello"), "echo: hello");
			assert.equal(await ask(rt, "SYSPROMPT"), "SYSPROMPT_OK");
			assert.equal(await ask(rt, "LIVE"), `TOOL live_main_tools OK: live:${sb.mainSessionId}:{"limit":3}`);
			const steer = await ask(rt, "STEER");
			assert.match(String(steer), /^TOOL steer_main OK: Approved by the human and delivered to the main agent as steer:\nplease stop/);
			assert.equal(steerRequests.length, 1);
			assert.equal(steerRequests[0]!.message, "please stop");
			assert.equal(steerRequests[0]!.mode, "steer");
			assert.equal(steerRequests[0]!.mainSessionFile, sb.mainSessionFile);
			assert.ok(events.some((e) => e.type === "bridge" && e.method === "steer_main" && e.phase === "end" && e.ok));
			assert.ok(events.some((e) => e.type === "session_event" && e.event.type === "agent_settled"));
		} finally {
			await rt.dispose();
		}
		assert.equal(rt.status, "disposed");
	});

	test("inherited extensions can launch a real Pi subagent through argv[1]", { timeout: TIMEOUT }, async () => {
		const rt = await WatcherRuntime.start(baseOptions(sb));
		const mainBefore = readFileSync(sb.mainSessionFile, "utf8");
		try {
			await rt.prompt("/fixture-launch-subagent");
			const output = join(sb.cwd, "subagent-result.json");
			const deadline = Date.now() + 25_000;
			while (!existsSync(output)) {
				assert.ok(Date.now() < deadline, "subagent launch did not finish");
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			const result = JSON.parse(readFileSync(output, "utf8"));
			assert.equal(result.error, undefined, result.error);
			assert.equal(result.cliEntry, locatePi().cliEntry);
			assert.match(result.stdout, /echo: nested hello/);
			assert.equal(readFileSync(sb.mainSessionFile, "utf8"), mainBefore);
			assert.equal((await rt.getState()).sessionId, rt.info!.sideSessionId);
		} finally {
			await rt.dispose();
		}
	});

	test("reopens the same side session (history kept, link matched), model change does not leak", { timeout: TIMEOUT * 2 }, async () => {
		// options.model / thinkingLevel are initial defaults only: they must not reset the model the
		// side session already uses (faux-2 from the first test).
		const rt = await WatcherRuntime.start(baseOptions(sb, { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "high" }));
		try {
			assert.equal(rt.info?.link, "matched");
			assert.deepEqual(rt.info?.model, { provider: "faux", id: "faux-2" });
			const texts = (await rt.getMessages()).filter((m) => m.role === "user").length;
			assert.ok(texts >= 4, "previous side conversation restored");
			assert.equal((await rt.getState()).model?.id, "faux-2", "side model restored from side session");
			const deltas: string[] = [];
			const result = await rt.promptAndWait("again", { onTextDelta: (d) => deltas.push(d), timeoutMs: TIMEOUT });
			assert.deepEqual(result, { disposition: "started", text: "echo: again" });
			// Pre-aborted signal: rejects without sending anything.
			const before = (await rt.getMessages()).length;
			const aborted = new AbortController();
			aborted.abort();
			await assert.rejects(rt.promptAndWait("never sent", { signal: aborted.signal }), /Aborted/);
			assert.equal((await rt.getMessages()).length, before);
			assert.equal(deltas.join(""), "echo: again");
			const rows = messagesToTranscript(await rt.getMessages());
			assert.ok(rows.some((r) => r.role === "tool" && r.text.startsWith("\u2192 live_main_tools")));
			assert.deepEqual(rows.slice(-2), [
				{ role: "user", text: "again", ts: rows.at(-2)!.ts },
				{ role: "assistant", text: "echo: again", ts: rows.at(-1)!.ts },
			]);
			const settings = JSON.parse(readFileSync(join(sb.agentDir, "settings.json"), "utf8"));
			assert.equal(settings.defaultModel, "faux-1", "side model change did not persist pi defaults");
		} finally {
			await rt.dispose();
		}
		assert.ok(!existsSync(join(sb.sessionDir, `watcher-${sb.mainSessionId}.lock`)), "lock released");
	});

	test("dispose during startup cleans up", { timeout: TIMEOUT }, async () => {
		const rt = new WatcherRuntime();
		const starting = rt.start(baseOptions(sb));
		await new Promise((r) => setTimeout(r, 50));
		await rt.dispose();
		await assert.rejects(starting);
		assert.equal(rt.status, "disposed");
		assert.ok(!existsSync(join(sb.sessionDir, `watcher-${sb.mainSessionId}.lock`)));
		// side session still usable afterwards
		const rt2 = await WatcherRuntime.start(baseOptions(sb));
		await rt2.dispose();
	});

	test("declined steer, main-session guard, and default-cancelled UI dialogs", { timeout: TIMEOUT * 2 }, async () => {
		let currentMain = sb.mainSessionId;
		let calls = 0;
		const rt = await WatcherRuntime.start(
			baseOptions(sb, {
				getCurrentMainSessionId: () => currentMain,
				liveMainTools: () => "live",
				steerMain: () => {
					calls++;
					return { approved: false, reason: "not now" };
				},
				onUiRequest: () => ({ confirmed: true }),
			}),
		);
		try {
			assert.match(String(await ask(rt, "STEER")), /declined this steer_main message: not now\. It was NOT delivered/);
			assert.equal(calls, 1);
			currentMain = "some-other-main";
			assert.match(String(await ask(rt, "LIVE")), /TOOL live_main_tools ERROR: .*main session changed/i);
			assert.match(String(await ask(rt, "STEER")), /TOOL steer_main ERROR: .*main session changed/i);
			assert.equal(calls, 1, "steer callback not invoked for a different main session");
		} finally {
			await rt.dispose();
		}

		// Without onUiRequest, dialogs are cancelled → fixture permission gate blocks steer_main.
		const rt2 = await WatcherRuntime.start(baseOptions(sb, { steerMain: () => ({ approved: true }) }));
		try {
			assert.match(String(await ask(rt2, "STEER")), /TOOL steer_main ERROR: blocked by fixture gate/);
		} finally {
			await rt2.dispose();
		}
	});

	test("bridge shutdown cancels in-flight calls; call ids are UUIDs", { timeout: TIMEOUT * 2 }, async () => {
		const callIds: string[] = [];
		let signalAborted: () => void = () => {};
		const aborted = new Promise<void>((r) => {
			signalAborted = r;
		});
		const rt = await WatcherRuntime.start(
			baseOptions(sb, {
				// Never resolves on its own: only the bridge's cancel can release it.
				liveMainTools: ({ signal }) =>
					new Promise((_, reject) => {
						signal.addEventListener("abort", () => {
							signalAborted();
							reject(new Error("cancelled"));
						});
					}),
			}),
		);
		rt.subscribe((e) => {
			if (e.type === "bridge" && e.phase === "start") callIds.push(e.callId);
		});
		try {
			assert.equal(await rt.prompt("LIVE"), "started");
			while (callIds.length === 0) await new Promise((r) => setTimeout(r, 20));
			assert.match(callIds[0]!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			// An extension reload in the child shuts the old bridge down (session_shutdown → detach)
			// while the tool call is still in flight; the detach must cancel it in the parent.
			await rt.send({ type: "prompt", message: "/fixture-reload" }).catch(() => undefined);
			await Promise.race([aborted, new Promise((_, rej) => setTimeout(() => rej(new Error("no cancel")), 10_000))]);
		} finally {
			await rt.dispose();
		}
	});

	test("lock prevents a second runtime on the same side session", { timeout: TIMEOUT * 2 }, async () => {
		const rt = await WatcherRuntime.start(baseOptions(sb));
		try {
			await assert.rejects(
				WatcherRuntime.start(baseOptions(sb)),
				(e: unknown) => e instanceof WatcherRuntimeError && e.code === "LOCKED",
			);
		} finally {
			await rt.dispose();
		}
	});

	test("unexpected child exit is reported; restart() resumes the same session", { timeout: TIMEOUT * 2 }, async () => {
		const events: WatcherRuntimeEvent[] = [];
		const rt = await WatcherRuntime.start(baseOptions(sb));
		rt.subscribe((e) => events.push(e));
		try {
			// A process "error" while the child is alive (e.g. failed send/kill) must not orphan it,
			// and repeated errors must not throw (persistent listener).
			const proc = (rt as unknown as { child: { proc: NodeJS.EventEmitter } }).child.proc;
			proc.emit("error", new Error("synthetic send failure"));
			proc.emit("error", new Error("second synthetic failure"));
			assert.equal(rt.status, "ready");
			assert.equal((await rt.getState()).sessionId, rt.info!.sideSessionId);
			assert.equal(events.filter((e) => e.type === "warning").length, 2);
			process.kill(rt.info!.pid!, "SIGKILL");
			await new Promise<void>((resolve) => {
				const check = () => (rt.status === "exited" ? resolve() : setTimeout(check, 20));
				check();
			});
			const exit = events.find((e) => e.type === "exit");
			assert.ok(exit && exit.type === "exit" && exit.expected === false);
			await assert.rejects(rt.getState(), (e: unknown) => e instanceof WatcherRuntimeError && e.code === "NOT_READY");
			const info = await rt.restart();
			assert.equal(rt.status, "ready");
			assert.equal(info.link, "matched");
		} finally {
			await rt.dispose();
		}
	});

	test("inherits parent CLI flags; drops flags of excluded extensions after a retry", { timeout: TIMEOUT * 3 }, async () => {
		const rt = await WatcherRuntime.start(
			baseOptions(sb, {
				inheritCliArgs: true,
				parentArgv: ["node", "pi", "--tools", "read", "--fake-watcher-flag", "--model", "ignored"],
			}),
		);
		try {
			assert.deepEqual(rt.info?.droppedFlags, ["fake-watcher-flag"]);
			assert.ok(rt.info?.args.includes("read,live_main_tools,steer_main"));
			assert.ok(!rt.info?.args.includes("--model"));
			assert.deepEqual([...(rt.info?.bridgeTools ?? [])].sort(), ["live_main_tools", "steer_main"]);
		} finally {
			await rt.dispose();
		}
	});

	test("refuses a main session file whose header id differs", async () => {
		const other = createSandbox("aaaaaaaa-0000-0000-0000-000000000000");
		try {
			writeFileSync(other.mainSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "different", cwd: other.cwd })}\n`);
			await assert.rejects(
				WatcherRuntime.start(baseOptions(other)),
				(e: unknown) => e instanceof WatcherRuntimeError && e.code === "MAIN_SESSION_MISMATCH",
			);
		} finally {
			other.cleanup();
		}
	});

	test("refuses a side session linked to another main session", { timeout: TIMEOUT * 2 }, async () => {
		const rt = WatcherRuntime.start(
			baseOptions(sb, {
				// Same side session as the earlier tests, but claiming to watch a different main session.
				mainSessionId: "bbbbbbbb-0000-0000-0000-000000000000",
				mainSessionFile: join(sb.cwd, "missing-main.jsonl"),
				sideSessionId: `watcher-${sb.mainSessionId}`,
			}),
		);
		await assert.rejects(rt, (e: unknown) => e instanceof WatcherRuntimeError && e.code === "SIDE_SESSION_MISMATCH");
	});
});
