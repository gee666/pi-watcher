## Summary
- Watcher is a persistent, independent conversation for observing and steering a running main agent.
- Opening, toggling, copying, and picking a model must not prompt or stop either agent.
- Public touchpoints: extension commands/events/UI, session metadata, tool registration, and Pi RPC.
- The child wraps exported package-manager implementation methods before extensions load.
- Main history is read-only input; steering requires human approval and is refused during compaction.
- Main risks are CLI/resource-loading drift, session identity, lifecycle races, and overlay focus.

## Intent
Give the human a side conversation without interrupting or duplicating the main agent's work.
One side session belongs to each main session; reopening and restarting preserve its history/model.
Observe the supplied main JSONL path and bounded live-tool previews, not source or verification work
unless explicitly requested. This is a prompt policy, not a sandbox. Never change main model defaults
or its status bar. Closing the panel leaves the side conversation running.

## Pi integration (public APIs)
`src/index.ts` registers `/watcher`, Alt+W, session/agent/tool/compaction handlers, and approved
`sendUserMessage(..., { deliverAs })`. It reads session ID/file/leaf, idle state, and project trust.
The overlay uses `ctx.ui.custom`, native dialogs, clipboard helpers, themes, and pi-tui components.
The child registers `live_main_tools`/`steer_main`, adds prompt sections in `before_agent_start`,
and persists its main-session link using `appendEntry`/session entries.
RPC supplies prompts, state/history/models, queue clearing, abort, extension dialogs, and settlement.
The package manifest exposes `src/index.ts`; credentials/settings/resources follow normal Pi loading.

## Internal Pi APIs
Internal/undocumented coupling is present: `runtime-child.mjs` calls exported CLI `main()` and
patches `DefaultPackageManager.prototype.resolve` and `resolveExtensionSources`, relying on the
resolved extension-resource shape (`enabled`, path, source metadata) before imports occur.
`runtime-args.ts` discovers npm package layouts (`dist/bundle/index.js`, `dist/index.js`, CLI entry).
There are no direct private Pi module imports or private Pi instance-field accesses in runtime code.
The `__PI_WATCHER_CHILD__` global and Node IPC protocol belong to Watcher, not Pi.
Standalone binaries alone cannot supply the importable child runtime.

## Weak points
Resource/CLI changes can break exclusions, inherited flags, or nested subagent launches.
Session replacement, reload, startup cancellation, approval, and child exit must release locks/listeners.
RPC message framing, event names, model persistence, and compaction delivery boundaries matter.
Inherited extensions can start work/processes; exclusion is essential and permissions remain inherited.
UI tests simulate terminal components; e2e does not drive an actual interactive PTY or clipboard.

## Tests
`npm run test:evergreen` runs `npm test` (latest Pi dependencies, TypeScript check, unit/integration),
then `test/e2e/watcher.test.ts`. No lint script is configured.
Unit tests cover bounded live state, prompt identity/policy, CLI filtering, JSONL transport, and UI.
`runtime-integration.test.ts` uses real RPC children and an offline provider to protect prompt-free
startup, inheritance/exclusions, nested Pi launches, isolated models, resume, approval refusal,
session guards, locks, shutdown, and recovery. `extension.test.cjs` exercises command → overlay →
RPC → approval → main delivery, including compaction refusal and shutdown cancellation.
E2E launches `$EVERGREEN_PI_BIN` (or `pi` on PATH) with stdin ignored and uses
`$EVERGREEN_E2E_MODEL` (required) for real main/side model calls. It verifies reading actual main
history, live-tool access, unchanged main history, and exact side-history restoration after restart.
It copies configured auth/models into a temporary agent directory; credentials are never committed.
The child uses the latest modular npm Pi from devDependencies, even with a standalone global host.

## Relevant changelog topics
Watch extension loading/package-manager resources, CLI entry/layout/flags, trust and built-in MCP;
RPC framing/dialogs/settlement; session JSONL/resume/tools and model persistence; steering/compaction;
TUI key parsing, overlay focus/disposal, and clipboard support. Pi 1.4.0 includes relevant fixes for
concurrent dialogs and resumed extension-tool activation. Tested against Pi 1.4.0.
