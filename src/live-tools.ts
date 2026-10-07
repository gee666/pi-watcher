/** Only in-flight metadata. No transcript, result buffers, polling, or timers. */
export const MAX_LIVE_TOOLS = 64;
const MAX_PREVIEW = 320;
interface LiveTool {
  id: string;
  name: string;
  parentId?: string;
  startedAt: number;
  updatedAt?: number;
  input?: string;
  output?: string;
}

function inputPreview(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const fields = args as Record<string, unknown>;
  // Do not stringify arbitrary arguments or keep references to them.
  for (const key of ["command", "path", "query", "task", "action"]) {
    if (typeof fields[key] === "string") return `${key}: ${fields[key].slice(0, MAX_PREVIEW)}`;
  }
  return undefined;
}

export class LiveTools {
  private calls = new Map<string, LiveTool>();
  get size(): number { return this.calls.size; }
  start(event: { toolCallId: string; toolName: string; parentToolCallId?: string; args?: unknown }): void {
    if (this.calls.size >= MAX_LIVE_TOOLS && !this.calls.has(event.toolCallId)) return;
    this.calls.set(event.toolCallId, {
      id: event.toolCallId, name: event.toolName.slice(0, 128), parentId: event.parentToolCallId,
      startedAt: Date.now(), input: inputPreview(event.args),
    });
  }
  update(event: { toolCallId: string; partialResult?: unknown }): void {
    const call = this.calls.get(event.toolCallId);
    if (!call) return;
    call.updatedAt = Date.now();
    const result = event.partialResult as { content?: Array<{ type?: string; text?: string }> } | undefined;
    if (!Array.isArray(result?.content)) return;
    // Keep only a short tail from one text block, replacing the previous preview.
    for (let i = result.content.length - 1; i >= 0; i--) {
      const part = result.content[i];
      if (part?.type === "text" && typeof part.text === "string") {
        call.output = part.text.slice(-MAX_PREVIEW);
        return;
      }
    }
  }
  end(id: string): void { this.calls.delete(id); }
  clear(): void { this.calls.clear(); }
  summary(): string | undefined {
    if (!this.calls.size) return undefined;
    return [...this.calls.values()].slice(0, 3).map((c) => c.name).join(", ") +
      (this.calls.size > 3 ? ` (+${this.calls.size - 3})` : "");
  }
  snapshot(params: { toolCallId?: string; limit?: number } = {}) {
    const now = Date.now();
    const limit = Number.isFinite(params.limit) ? Math.max(1, Math.min(MAX_LIVE_TOOLS, Math.floor(params.limit!))) : 16;
    const calls = params.toolCallId ? [this.calls.get(params.toolCallId)].filter((v): v is LiveTool => !!v) : [...this.calls.values()];
    return {
      asOf: new Date(now).toISOString(),
      note: `Only currently running tools; completed calls are removed immediately. At most ${MAX_LIVE_TOOLS} concurrent calls are tracked. Read the main session file for history.`,
      tools: calls.slice(0, limit).map((c) => ({ ...c, elapsedMs: now - c.startedAt })),
    };
  }
}
