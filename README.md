# Pi Watcher

A persistent side-agent conversation for your running [Pi](https://pi.dev) agent.

**Package:** `oira666_pi-watcher` · **Version:** `0.0.3` · **License:** MIT

## Install

```sh
pi install npm:oira666_pi-watcher
```

Then restart Pi or run `/reload`. Requires Node.js **22.19+** and the modular Pi installation. Tested against **Pi 1.0.4**; the child launcher depends on that version's package-manager loading interfaces. Standalone compiled Pi binaries are not supported.

For local development:

```sh
npm ci
pi -e ./src/index.ts
```

## Use

| Command | Action |
| --- | --- |
| `/watcher` | Create/resume the side agent and show its conversation. **Sends no prompt.** |
| `/watcher Why is it retrying?` | Open and send exactly that question. |
| `/watcher model` | Open the side agent's model picker. Does not prompt either agent. |

These are human-facing TUI commands, not tools exposed to the main agent. They work while the main agent is running, including during compaction.

The panel opens immediately while the side process initializes its inherited extensions and MCPs in the background. You can type straight away; a submitted question waits for initialization and is sent once ready. `/stop` cancels a question waiting for startup. Opening without a question still sends no prompt. Saved history and the selected model appear when initialization finishes; reopening an already initialized side agent reuses it.

Inside the overlay:

- Type a question and press **Enter**. Use **Shift+Enter** for a newline.
- **Esc** returns to the main view without stopping either agent. Run `/watcher` again to return; conversation, draft, and scroll position are retained.
- `/model` opens a searchable provider/model picker. Its selection affects **only the side agent** and is persisted in that side conversation. You can change models while the side agent is running, just like in Pi; switching does not abort the current reply.
- `/stop` cancels only the side agent and clears its queued messages.
- `/copy` copies to the system clipboard, because terminal mouse selection spans the full terminal width. Messages are numbered in the transcript (`You #n`, `Watcher #n`):
  - `/copy`: last Watcher reply · `/copy 3`: Watcher #3
  - `/copy me`: your last message · `/copy me 2`: You #2
  - `/copy all`: the whole side conversation as Markdown

  It uses Pi's clipboard support (native clipboard, `wl-copy`/`xclip`/`xsel`, or OSC 52 over SSH). Copying never sends a prompt.
- `/help` shows controls. **Page Up/Down**, **Ctrl+Home/End**, or the mouse wheel scroll the conversation.
- Watcher never modifies the main status bar. Reopen the overlay to see pending approvals; finished replies can trigger a notification.

A question passed to `/watcher` while the side agent is already replying is saved as a draft rather than silently queued. The overlay displays the latest 120 messages; older history remains in the side session file and model conversation.

### Steering the main agent

Ask the side agent to send an instruction. Its `steer_main` tool presents **Send / Edit / Cancel** in the overlay. Nothing is sent without your explicit approval. You can close the overlay and reopen it to answer later.

Approved messages enter Pi's normal steering/follow-up queue, with attribution:

```text
[Watcher — approved by you] Inspect the database setup failure before retrying.
```

They appear like other user messages. Steering takes effect at Pi's next safe turn boundary, not in the middle of an executing tool. Sending while main is idle starts a new turn (the approval warns about this). During main-session compaction, delivery is refused with a visible notice rather than falsely reported as sent.

## What the side agent sees

Its system prompt names the **main session JSONL path**, session ID, and the two added tools:

- **`live_main_tools`**: current running tools, elapsed time, short input/output previews, and the main branch leaf ID.
- **`steer_main`**: human-approved messages to the main agent.

It uses the inherited file reader for session history. The prompt explicitly distinguishes the authoritative main transcript from Watcher's own session file: `PI_SESSION_FILE` and `PI_SESSION_ID` in Watcher's shell refer to Watcher, not the main agent. It reads the supplied main path directly rather than searching session directories. The prompt tells it to read **only session files and live tool data** by default—not source code, tests, git, or other checks. It must not redo or verify the main agent's work unless you specifically ask. The same rule applies even though inherited tools remain available.

The live tracker keeps at most **64 in-flight calls**, each with tiny previews. It stores no transcript or full tool results, uses no polling timer, and deletes a call immediately when it ends. Completed history belongs in Pi's session file. Live text/model streams without tool calls are not recorded by the tracker.

This is an instruction-based workflow, **not a sandbox**. Inherited tools and extensions retain their normal permissions. The side agent uses a separate session file; it never opens the main file as its writable session manager.

## Settings

On first use, Watcher creates:

```text
~/.pi/agent/pi-watcher.json
```

It respects `PI_CODING_AGENT_DIR`. Example:

```json
{
  "excludedExtensions": [],
  "sessionDir": "pi-watcher-sessions"
}
```

Optional initial model and thinking defaults:

```json
{
  "excludedExtensions": ["some-extension-package", "builtin:llama.cpp", "./extensions/unwanted.ts"],
  "model": { "provider": "your-provider", "modelId": "your-model-id" },
  "thinkingLevel": "medium"
}
```

- `excludedExtensions`: package/extension names, paths, `npm:`/`git:` sources, or `builtin:<name>`. An excluded directory excludes its descendants. Relative `./` paths resolve from the agent directory. **Watcher itself is always excluded.**
- `sessionDir`: separate side-conversation storage; defaults to `<agent-dir>/pi-watcher-sessions`. Relative paths resolve from the agent directory.
- `model` and `thinkingLevel`: initial defaults for a **new** side conversation. A resumed conversation keeps its own saved selections. If omitted, Pi selects from the inherited settings.

Run `/reload` after editing settings. Watcher never changes Pi's global model defaults.

### Inheritance

The side agent is a separate **Pi RPC process**, running in the main session's working directory. It loads the normal CLI resources: extensions, custom providers, error handlers, MCP configuration, tools, skills, credentials, models, and trusted project settings. Resource/tool flags from the main CLI are inherited; main model/session/mode flags are not. Extensions listed in `excludedExtensions`, and Watcher itself, are filtered **before loading**.

Important boundaries:

- Extension code is reloaded, not copied with its in-memory state. Main-only runtime registrations or temporary tool/model changes are not automatically mirrored.
- RPC supports inherited confirmation/select/input dialogs; Watcher temporarily closes its overlay to show those using Pi's native UI. An inherited multiline editor request uses a cancellable single-line input. TUI-only custom components are unavailable in RPC mode.
- Inherited extensions can start their own processes, open brokers, or initiate work on startup. Watcher itself sends no startup prompt, but cannot promise that every inherited extension is idle. Exclude extensions whose startup behavior you do not want duplicated (especially exclusive browser/terminal integrations).
- Normal Pi cache-warming and provider settings are inherited. Provider requests/usage for the side agent are separate from main's totals.
- A one-off main CLI `--api-key` is not forwarded; use configured credentials for the chosen side model.
- Main sessions started with `--no-session` cannot be watched.

## Persistence and lifecycle

One side session is associated with each main session ID. Reopening the overlay resumes the same conversation; restarting Pi and resuming the same main session also restores it. `/new`, `/resume`, `/fork`, reload, and shutdown dispose the old child and its listeners. The next `/watcher` starts/resumes the appropriate side session.

Closing only the overlay leaves the side agent alive, including any inherited MCP/extension processes. Main-session history remains read-only input to the side agent. A lock prevents two Watcher runtimes from writing the same side session.

## Development

```sh
npm ci
npm run check
npm test
npm pack --dry-run --ignore-scripts
```

Tests use an offline scripted provider; no paid model calls are needed. They exercise the real RPC child, extension inheritance/exclusion, session resume, models, steering, main-extension integration, transport limits, live-tool cleanup, and overlay keyboard/rendering behavior.

The implementation is in `src/index.ts` (integration), `src/runtime*` (isolated child and RPC/IPC bridge), `src/live-tools.ts`, `src/config.ts`, and `src/ui*` (overlay).
