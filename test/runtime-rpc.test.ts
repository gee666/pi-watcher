import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { attachJsonlReader, RpcCommandError, RpcConnection, RpcTimeoutError } from "../src/runtime-rpc.ts";

test("JSONL reader splits only on LF, keeps U+2028 inside strings, handles CRLF and split chunks", () => {
	const stream = new PassThrough();
	const lines: string[] = [];
	attachJsonlReader(stream, (line) => lines.push(line));
	const payload = JSON.stringify({ text: "a\u2028b\u2029c" });
	const buf = Buffer.from(`${payload}\r\n{"x":"é`);
	stream.write(buf.subarray(0, buf.length - 1)); // split inside the multibyte char
	stream.write(buf.subarray(buf.length - 1));
	stream.write('"}\n');
	stream.end();
	assert.equal(lines.length, 2);
	assert.equal(JSON.parse(lines[0]!).text, "a\u2028b\u2029c");
	assert.equal(JSON.parse(lines[1]!).x, "é");
});

test("RpcConnection correlates responses by id, routes events, times out, rejects on close", async () => {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const records: Record<string, unknown>[] = [];
	const noise: string[] = [];
	const conn = new RpcConnection(stdin, stdout, {
		onRecord: (r) => records.push(r),
		onProtocolNoise: (_line, reason) => noise.push(reason),
	});
	const sent: Record<string, unknown>[] = [];
	attachJsonlReader(stdin, (line) => sent.push(JSON.parse(line)));

	const p1 = conn.request<{ ok: number }>({ type: "get_state" }, 1000);
	const p2 = conn.request({ type: "set_model" }, 1000);
	await new Promise((r) => setImmediate(r));
	assert.equal(sent.length, 2);
	// answer out of order
	stdout.write(`${JSON.stringify({ type: "response", id: sent[1]!.id, command: "set_model", success: false, error: "nope" })}\n`);
	stdout.write(`${JSON.stringify({ type: "agent_start" })}\nnot json\n`);
	stdout.write(`${JSON.stringify({ type: "response", id: sent[0]!.id, command: "get_state", success: true, data: { ok: 1 } })}\n`);
	assert.deepEqual(await p1, { ok: 1 });
	await assert.rejects(p2, (e: unknown) => e instanceof RpcCommandError && e.message === "nope");
	assert.deepEqual(records, [{ type: "agent_start" }]);
	assert.deepEqual(noise, ["invalid JSON"]);

	await assert.rejects(conn.request({ type: "slow" }, 20), RpcTimeoutError);
	const pending = conn.request({ type: "never" }, 0);
	conn.close(new Error("gone"));
	await assert.rejects(pending, /gone/);
	await assert.rejects(conn.request({ type: "after" }), /gone/);
});

test("JSONL reader drops oversized records but keeps the stream in sync", () => {
	const stream = new PassThrough();
	const lines: string[] = [];
	const oversize: number[] = [];
	attachJsonlReader(stream, (line) => lines.push(line), { maxLineChars: 1000, onOversize: (n) => oversize.push(n) });
	stream.write('{"a":1}\n');
	stream.write("x".repeat(600));
	stream.write("x".repeat(600)); // exceeds limit mid-record (no LF yet)
	stream.write(`${"x".repeat(5000)}\n{"b":2}\n`);
	stream.write(`${"y".repeat(2000)}\n{"c":3}\n`); // oversized record contained in one chunk
	stream.end();
	assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
	assert.deepEqual(oversize, [6200, 2000]);
});

test("JSONL reader is linear for a huge record delivered in small chunks", () => {
	const stream = new PassThrough();
	const lines: string[] = [];
	attachJsonlReader(stream, (line) => lines.push(line));
	const chunk = "z".repeat(16 * 1024);
	const started = Date.now();
	for (let i = 0; i < 2048; i++) stream.emit("data", chunk); // 32 MiB single record
	stream.emit("data", "\n");
	assert.equal(lines.length, 1);
	assert.equal(lines[0]!.length, 32 * 1024 * 1024);
	assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
});

test("RpcConnection rejects unserializable commands without leaking a pending request", async () => {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const conn = new RpcConnection(stdin, stdout, { onRecord: () => {} });
	await assert.rejects(conn.request({ type: "bad", value: 1n }, 0), /BigInt/);
	assert.equal((conn as unknown as { pending: Map<string, unknown> }).pending.size, 0);
});
