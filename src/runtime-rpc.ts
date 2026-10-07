/**
 * Minimal, strict RPC transport for a `pi --mode rpc` child:
 * - LF-only JSONL framing (not node:readline, which also splits on U+2028/U+2029),
 * - request/response correlation by id with per-request timeouts,
 * - stdin backpressure.
 */

import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** Default maximum size of one JSONL record (characters). Longer records are dropped. */
export const DEFAULT_MAX_LINE_CHARS = 64 * 1024 * 1024;

/**
 * LF-only JSONL reader. Scans only newly received text (no rescans of the pending line), slices
 * the buffer once per chunk, and drops records longer than `maxLineChars` (reported through
 * `onOversize`) instead of buffering without bound.
 */
export function attachJsonlReader(
	stream: Readable,
	onLine: (line: string) => void,
	options: { maxLineChars?: number; onOversize?: (length: number) => void } = {},
): () => void {
	const maxLine = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let discarding = false; // inside an oversized record: drop until the next LF
	let discarded = 0;
	const emit = (line: string) => {
		const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (clean.length > 0) onLine(clean);
	};
	const push = (text: string) => {
		let start = 0;
		while (start < text.length) {
			const nl = text.indexOf("\n", start);
			if (nl === -1) {
				const rest = text.length - start;
				if (discarding) {
					discarded += rest;
				} else if (buffer.length + rest > maxLine) {
					discarding = true;
					discarded = buffer.length + rest;
					buffer = "";
				} else {
					buffer += start === 0 ? text : text.slice(start);
				}
				return;
			}
			if (discarding) {
				options.onOversize?.(discarded + (nl - start));
				discarding = false;
				discarded = 0;
			} else if (buffer.length + (nl - start) > maxLine) {
				options.onOversize?.(buffer.length + (nl - start));
				buffer = "";
			} else {
				const line = buffer + text.slice(start, nl);
				buffer = "";
				emit(line);
			}
			start = nl + 1;
		}
	};
	const onData = (chunk: Buffer | string) => {
		push(typeof chunk === "string" ? chunk : decoder.write(chunk));
	};
	const onEnd = () => {
		push(decoder.end());
		if (discarding) options.onOversize?.(discarded);
		else if (buffer.length > 0) emit(buffer);
		buffer = "";
		discarding = false;
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export class RpcCommandError extends Error {
	readonly command: string;
	constructor(command: string, message: string) {
		super(message);
		this.name = "RpcCommandError";
		this.command = command;
	}
}

export class RpcTimeoutError extends Error {
	readonly command: string;
	constructor(command: string, timeoutMs: number) {
		super(`RPC command "${command}" timed out after ${timeoutMs}ms`);
		this.name = "RpcTimeoutError";
		this.command = command;
	}
}

interface Pending {
	command: string;
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
}

export interface RpcRecordHandlers {
	/** Any non-response record (session events, extension_ui_request, extension_error, ...). */
	onRecord: (record: Record<string, unknown>) => void;
	/** A line that was not valid JSON, or a response with an unknown id. */
	onProtocolNoise?: (line: string, reason: string) => void;
	/** Max JSONL record size in characters (default DEFAULT_MAX_LINE_CHARS). */
	maxLineChars?: number;
}

export class RpcConnection {
	private readonly pending = new Map<string, Pending>();
	private readonly detachReader: () => void;
	private counter = 0;
	private closedError: Error | undefined;
	private writeChain: Promise<void> = Promise.resolve();
	private readonly stdin: Writable;
	private readonly handlers: RpcRecordHandlers;

	constructor(stdin: Writable, stdout: Readable, handlers: RpcRecordHandlers) {
		this.stdin = stdin;
		this.handlers = handlers;
		this.detachReader = attachJsonlReader(stdout, (line) => this.handleLine(line), {
			maxLineChars: handlers.maxLineChars,
			onOversize: (length) => this.handlers.onProtocolNoise?.("", `record of ${length} chars exceeds limit; dropped`),
		});
		stdin.on("error", (error) => this.close(new Error(`side agent stdin error: ${error.message}`)));
	}

	get closed(): boolean {
		return this.closedError !== undefined;
	}

	/** Send a command and resolve with its `data` (or reject with the error). */
	request<T = unknown>(command: Record<string, unknown> & { type: string }, timeoutMs?: number): Promise<T> {
		if (this.closedError) return Promise.reject(this.closedError);
		const id = `pw-${++this.counter}`;
		return new Promise<T>((resolve, reject) => {
			const entry: Pending = { command: command.type, resolve: resolve as (d: unknown) => void, reject };
			if (timeoutMs && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
				entry.timer = setTimeout(() => {
					if (!this.pending.delete(id)) return;
					reject(new RpcTimeoutError(command.type, timeoutMs));
				}, timeoutMs);
				entry.timer.unref?.();
			}
			this.pending.set(id, entry);
			this.write({ ...command, id }).catch((error: Error) => {
				if (!this.pending.delete(id)) return;
				if (entry.timer) clearTimeout(entry.timer);
				reject(error);
			});
		});
	}

	/** Write one record honoring stdin backpressure; writes are serialized. */
	write(record: unknown): Promise<void> {
		if (this.closedError) return Promise.reject(this.closedError);
		let line: string;
		try {
			line = serializeJsonLine(record);
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		const run = async () => {
			if (this.closedError) throw this.closedError;
			if (this.stdin.destroyed || !this.stdin.writable) throw new Error("side agent stdin is closed");
			const ok = this.stdin.write(line);
			if (!ok) {
				await new Promise<void>((resolve, reject) => {
					const onDrain = () => {
						cleanup();
						resolve();
					};
					const onClose = () => {
						cleanup();
						reject(new Error("side agent stdin closed"));
					};
					const cleanup = () => {
						this.stdin.off("drain", onDrain);
						this.stdin.off("close", onClose);
						this.stdin.off("error", onClose);
					};
					this.stdin.once("drain", onDrain);
					this.stdin.once("close", onClose);
					this.stdin.once("error", onClose);
				});
			}
		};
		const next = this.writeChain.then(run, run);
		this.writeChain = next.catch(() => undefined);
		return next;
	}

	/** Reject everything outstanding and stop reading. Idempotent. */
	close(error: Error): void {
		if (this.closedError) return;
		this.closedError = error;
		this.detachReader();
		for (const [id, entry] of this.pending) {
			this.pending.delete(id);
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(error);
		}
	}

	private handleLine(line: string): void {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			this.handlers.onProtocolNoise?.(line, "invalid JSON");
			return;
		}
		if (!record || typeof record !== "object" || Array.isArray(record)) {
			this.handlers.onProtocolNoise?.(line, "not an object");
			return;
		}
		const rec = record as Record<string, unknown>;
		if (rec.type === "response") {
			const id = typeof rec.id === "string" ? rec.id : undefined;
			const entry = id ? this.pending.get(id) : undefined;
			if (!entry || !id) {
				this.handlers.onProtocolNoise?.(line, "response without a pending request");
				return;
			}
			this.pending.delete(id);
			if (entry.timer) clearTimeout(entry.timer);
			if (rec.success === true) entry.resolve(rec.data);
			else entry.reject(new RpcCommandError(String(rec.command ?? entry.command), String(rec.error ?? "command failed")));
			return;
		}
		this.handlers.onRecord(rec);
	}
}
