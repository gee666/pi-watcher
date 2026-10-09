import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "./config.ts";
import { LiveTools } from "./live-tools.ts";
import {
  isWatcherChildProcess, messagesToTranscript, WatcherRuntime,
  type UiDialogRequest, type UiDialogResponse, type WatcherRuntimeEvent,
} from "./runtime.ts";
import { openWatcherUI, WatcherStore, type WatcherController } from "./ui.ts";

interface Side {
  id: string;
  ctx: ExtensionContext;
  runtime: WatcherRuntime;
  store: WatcherStore;
  controller: WatcherController;
  ready: Promise<void>;
  startupError?: string;
  pendingQuestion?: { text: string };
  lifetime: AbortController;
  overlay?: AbortController;
  dialogCount: number;
  dialogQueue: Promise<unknown>;
  unsubscribe?: () => void;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function watcher(pi: ExtensionAPI): void {
  if (isWatcherChildProcess()) return;
  const live = new LiveTools();
  let current: ExtensionContext | undefined;
  let side: Side | undefined;
  let compacting = false;

  function isCurrent(s: Side): boolean {
    return side === s && !s.lifetime.signal.aborted && current?.sessionManager.getSessionId() === s.id;
  }
  function mainStatus(): void {
    if (!side || !current) return;
    side.store.setMain({ status: current.isIdle() ? "idle" : "running", activity: compacting ? "compacting" : live.summary() });
  }
  async function show(s: Side, initialAction?: "model"): Promise<void> {
    if (!isCurrent(s) || s.dialogCount || s.store.state.open) return;
    s.overlay = new AbortController();
    const close = () => s.overlay?.abort();
    s.lifetime.signal.addEventListener("abort", close, { once: true });
    try {
      await openWatcherUI(s.ctx, { store: s.store, controller: s.controller, title: "Watcher", signal: s.overlay.signal, initialAction });
    } finally {
      s.lifetime.signal.removeEventListener("abort", close);
    }
  }

  // Pi's inherited extension dialogs use its native UI. Close the watcher overlay first,
  // serialize dialogs, and reopen it afterwards, never leaving two editors competing for focus.
  async function extensionDialog(s: Side, request: UiDialogRequest, signal: AbortSignal): Promise<UiDialogResponse> {
    const run = async (): Promise<UiDialogResponse> => {
      if (!isCurrent(s) || signal.aborted) return { cancelled: true };
      const reopen = s.store.state.open;
      s.dialogCount++;
      s.overlay?.abort();
      await s.store.uiPromise;
      const timeout = "timeout" in request && typeof request.timeout === "number" ? request.timeout : undefined;
      const opts = { signal: AbortSignal.any([signal, s.lifetime.signal]), timeout };
      const title = `Watcher: ${request.title}`;
      try {
        if (!isCurrent(s) || opts.signal.aborted) return { cancelled: true };
        switch (request.method) {
          case "confirm": return { confirmed: await s.ctx.ui.confirm(title, request.message, opts) };
          case "select": {
            const value = await s.ctx.ui.select(title, request.options, opts);
            return value === undefined ? { cancelled: true } : { value };
          }
          case "input": {
            const value = await s.ctx.ui.input(title, request.placeholder, opts);
            return value === undefined ? { cancelled: true } : { value };
          }
          case "editor": {
            // input supports cancellation, unlike Pi's native multi-line editor API.
            const value = await s.ctx.ui.input(`${title} (suggested: ${request.prefill ?? ""})`, request.prefill, opts);
            return value === undefined ? { cancelled: true } : { value };
          }
        }
      } finally {
        s.dialogCount--;
        if (reopen && isCurrent(s)) void show(s).catch((e) => s.ctx.ui.notify(errorText(e), "error"));
      }
    };
    const result = s.dialogQueue.then(run, run);
    s.dialogQueue = result.catch(() => {});
    return result;
  }

  function event(s: Side, incoming: WatcherRuntimeEvent): void {
    if (!isCurrent(s)) return;
    const store = s.store;
    if (incoming.type === "session_event") {
      const e = incoming.event;
      switch (e.type) {
        case "agent_start": store.setSide({ status: "running", error: undefined }); break;
        case "message_update": {
          const delta = e.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (delta?.type === "text_delta" && delta.delta) store.appendLive(delta.delta);
          break;
        }
        case "message_end": {
          const message = e.message as { role?: string; errorMessage?: string } | undefined;
          if (!message || message.role === "user") break; // UI already added the user's question.
          if (message.role === "assistant") store.setLive(undefined);
          for (const row of messagesToTranscript([message])) store.addMessage(row.role, row.text);
          if (message.errorMessage) store.setSide({ error: message.errorMessage });
          break;
        }
        case "tool_execution_start": store.setSide({ activity: String(e.toolName).slice(0, 128) }); break;
        case "tool_execution_end": store.setSide({ activity: undefined }); break;
        case "auto_compaction_start": store.setSide({ activity: "compacting" }); break;
        case "auto_retry_start": store.setSide({ activity: "retrying" }); break;
        case "model_select": {
          const model = e.model as { provider: string; id: string } | undefined;
          if (model) store.setModel(model);
          break;
        }
        case "agent_settled":
          store.endTurn({ error: store.state.side.error });
          if (!store.state.open) s.ctx.ui.notify("Watcher reply ready — /watcher", "info");
          break;
      }
    } else if (incoming.type === "exit" && !incoming.expected) {
      store.endTurn({ error: incoming.error ?? "Side agent exited. Reopen /watcher to resume." });
    } else if (incoming.type === "extension_error") {
      s.ctx.ui.notify(`Watcher extension: ${incoming.error ?? "unknown error"}`, "warning");
    } else if (incoming.type === "warning") {
      s.ctx.ui.notify(`Watcher: ${incoming.message}`, "warning");
    } else if (incoming.type === "ui" && incoming.request.method === "notify") {
      s.ctx.ui.notify(`Watcher: ${incoming.request.message}`, incoming.request.notifyType ?? "info");
    }
  }

  async function dispose(): Promise<void> {
    const old = side;
    side = undefined;
    if (!old) return;
    old.lifetime.abort();
    old.overlay?.abort();
    old.store.dispose();
    old.unsubscribe?.();
    await old.runtime.dispose();
  }

  async function ensure(ctx: ExtensionContext): Promise<Side> {
    current = ctx;
    const id = ctx.sessionManager.getSessionId();
    if (side && side.id === id && !side.startupError && side.runtime.status !== "exited" && side.runtime.status !== "disposed") {
      return side;
    }
    await dispose();
    const mainSessionFile = ctx.sessionManager.getSessionFile();
    if (!mainSessionFile) throw new Error("Watcher needs a persisted main session (not --no-session).");
    const settings = loadSettings(getAgentDir());
    const runtime = new WatcherRuntime();
    const store = new WatcherStore();
    const s: Side = {
      id, ctx, runtime, store, lifetime: new AbortController(), ready: Promise.resolve(),
      dialogCount: 0, dialogQueue: Promise.resolve(),
      controller: {
        async submit(text) {
          if (!isCurrent(s)) throw new Error("Main session changed. Reopen /watcher.");
          const pending = { text };
          s.pendingQuestion = pending;
          await s.ready;
          if (!isCurrent(s) || s.pendingQuestion !== pending) return;
          s.pendingQuestion = undefined;
          const disposition = await runtime.prompt(text);
          if (disposition === "handled") store.endTurn();
        },
        async stop() {
          if (s.pendingQuestion) {
            s.pendingQuestion = undefined;
            store.endTurn();
            if (!store.state.model) store.setSide({ status: "starting" });
            return;
          }
          // Abort alone can continue queued work in Pi. Clear only the SIDE queue first.
          await runtime.clearQueue();
          await runtime.abort();
          store.endTurn({ aborted: true });
        },
        async listModels() { await s.ready; return runtime.getAvailableModels(); },
        async setModel(model) {
          await s.ready;
          if (!isCurrent(s)) throw new Error("Main session changed. Reopen /watcher.");
          await runtime.setModel(model.provider, model.id);
        },
      },
    };
    side = s;
    s.unsubscribe = runtime.subscribe((e) => event(s, e));
    mainStatus();
    store.setSide({ status: "starting" });
    s.ready = (async () => {
      // Let the overlay mount before doing child discovery/spawn or waiting for extensions/MCPs.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!isCurrent(s)) return;
      const info = await runtime.start({
        cwd: ctx.cwd, mainSessionFile, mainSessionId: id,
        sessionDir: settings.sessionDir, excludedExtensions: settings.excludedExtensions,
        model: settings.model, thinkingLevel: settings.thinkingLevel,
        projectTrusted: ctx.isProjectTrusted(),
        getCurrentMainSessionId: () => current?.sessionManager.getSessionId(),
        liveMainTools: ({ params }) => JSON.stringify({
          mainSessionFile, mainSessionId: id, leafId: current?.sessionManager.getLeafId(),
          state: compacting ? "compacting" : current?.isIdle() ? "idle" : "working",
          ...live.snapshot(params),
        }),
        steerMain: async ({ message, mode, rationale, signal }) => {
          if (!isCurrent(s)) return { approved: false, reason: "Main session changed." };
          const decision = await store.requestSteeringApproval({ text: message,
            reason: `${rationale ?? "Message to main agent."} ${ctx.isIdle() ? "Main is idle: sending starts a new turn." : "Delivery waits for a safe turn boundary."}` }, signal);
          if (decision.action !== "send" || signal.aborted || !isCurrent(s)) {
            return { approved: false, reason: "Cancelled or main session changed." };
          }
          if (compacting) {
            ctx.ui.notify("Watcher: main is compacting; message was NOT sent. Ask again after compaction.", "warning");
            return { approved: false, reason: "Main is compacting; not sent. Ask the human before retrying." };
          }
          const text = `[Watcher — approved by you] ${decision.text}`;
          pi.sendUserMessage(text, { deliverAs: mode });
          store.addMessage("tool", `Sent to main (${mode}): ${text}`);
          return { approved: true, deliveredMessage: text, mode };
        },
        onUiRequest: (request, { signal }) => extensionDialog(s, request, signal),
      });
      if (!isCurrent(s)) { await runtime.dispose(); return; }
      const [messages, state] = await Promise.all([runtime.getMessages(), runtime.getState()]);
      if (!isCurrent(s)) return;
      store.setMessages(messagesToTranscript(messages));
      // The user can submit while startup is in progress. Preserve that unsent question
      // when replacing the initial empty display with the restored conversation.
      if (s.pendingQuestion) store.addMessage("user", s.pendingQuestion.text);
      store.setModel(state.model ?? undefined);
      store.setSide({ status: runtime.isBusy || s.pendingQuestion ? "running" : "idle" });
      for (const warning of info.warnings) ctx.ui.notify(`Watcher: ${warning}`, "warning");
    })();
    // Observe failures even when no question/model request awaits readiness. Keep the
    // panel open so errors are visible, and allow the next /watcher to retry startup.
    void s.ready.catch((error) => {
      if (!isCurrent(s)) return;
      s.startupError = errorText(error);
      s.pendingQuestion = undefined;
      store.endTurn({ error: s.startupError });
      ctx.ui.notify(`Watcher: ${s.startupError}`, "error");
      void runtime.dispose();
    });
    return s;
  }

  pi.on("session_start", async (_event, ctx) => {
    await dispose();
    current = ctx;
    compacting = false;
    live.clear();
  });
  pi.on("session_shutdown", async () => { current = undefined; live.clear(); await dispose(); });
  pi.on("agent_start", () => mainStatus());
  pi.on("agent_settled", () => { compacting = false; live.clear(); mainStatus(); });
  pi.on("tool_execution_start", (e) => { live.start(e); mainStatus(); });
  pi.on("tool_execution_update", (e) => { live.update(e); });
  pi.on("tool_execution_end", (e) => { live.end(e.toolCallId); mainStatus(); });
  pi.on("session_before_compact", () => { compacting = true; mainStatus(); });
  pi.on("session_compact", () => { compacting = false; mainStatus(); });
  pi.on("session_compact_failed", () => { compacting = false; mainStatus(); });

  pi.registerShortcut("alt+w", {
    description: "Toggle the Watcher panel",
    handler: async (ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      try {
        if (side && isCurrent(side) && side.store.state.open) {
          side.overlay?.abort();
          return;
        }
        await show(await ensure(ctx));
      } catch (error) { ctx.ui.notify(`Watcher: ${errorText(error)}`, "error"); }
    },
  });

  pi.registerCommand("watcher", {
    description: "Open the side agent; /watcher <question> to ask; /watcher model to choose its model",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/watcher is a human-only interactive terminal command.", "warning"); return; }
      try {
        const s = await ensure(ctx);
        const question = args.trim();
        if (question && question !== "model") {
          if (s.runtime.isBusy || s.store.state.side.status === "running") {
            s.store.setDraft(question);
            ctx.ui.notify("Watcher is replying; your question is saved as a draft.", "info");
          } else {
            s.store.beginTurn(question);
            // Open UI immediately; inherited permission dialogs may need it during preflight.
            void Promise.resolve(s.controller.submit(question)).catch((e) => s.store.endTurn({ error: errorText(e) }));
          }
        }
        await show(s, question === "model" ? "model" : undefined);
      } catch (error) { ctx.ui.notify(`Watcher: ${errorText(error)}`, "error"); }
    },
  });
}
