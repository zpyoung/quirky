# Session Info technical specification

Status: Ready for adversarial review. Complexity gate: crosses protocol/launch pipeline, built-in daemon plugin and UI. Behavioral authority: [logic.md](logic.md).

## Architecture
[Behavior](logic.md#conceptual-model), [data flow](logic.md#data-flow).

Add `plugins/quirky.session-info` with daemon entry `main.ts`, CLI entry `cli.ts`, UI entry `src/ui.tsx` built as `dist/ui.js`, manifest and package metadata. The plugin owns the projection and preferences; do not add feature logic to the kernel. Filesystem reads happen in the daemon plugin, not the webview. Built-ins are discovered by `packages/daemon/src/plugins/discover.ts`; build plugin UI using the discovery pattern in `packages/ui/build.ts`.

Reuse public RPC methods in quirky.session (get, list, resume), quirky.agent-status (get, hooksStatus), quirky.terminal (workspace, focusPane, openExternal), and ui (state, view.open, panel.open, command.run). Add the missing resume-command projection in this plugin rather than call a nonexistent session/resumeCommand. Terminal focus is authoritative in terminal workspace state plus the new focus-context primitive below. Do not fall back to a prior agent for a non-terminal view/pane.

The only kernel growth is generic JSON-valued launch argument composition. Existing Claude hook settings and the new statusline settings use that public capability. No Claude-specific behavior enters the kernel.

## Code references
[Scope](logic.md#scope--non-goals).

Root for all anchors: `/Users/zpyoung/orca/workspaces/quirky/build-lane-6/`.

- `packages/protocol/src/plugins.ts:229-247`: `LaunchHookInput`, `LaunchPatch`, `LaunchHook`; extend with composable JSON args.
- `packages/daemon/src/plugins/launch-hooks.ts:55-119`: `runLaunchHooks`; ordered patches and validation.
- `plugins/quirky.agent-status/main.ts:12-29`: `agentHooks`; migrate Claude settings contribution, retaining version gate and Codex notify.
- `plugins/quirky.agent-status/src/claude-settings.ts`: `claudeSettings`; retain the pure version-aware hook builder. The obsolete settings-file writer is removed by the inline JSON cutover.
- `plugins/quirky.session/src/sessions.ts:190-286`: create/resume run launch hooks and pass hookArgs into prepareLaunch/prepareResume; callsites remain compatible.
- `packages/daemon/src/server.ts:49-70`: authenticated `hook.received` event. Use source `session-info-claude`; no new HTTP server/endpoint.
- `packages/protocol/src/model.ts:149-217`: Session and provider session identity.
- `plugins/quirky.agent-status/src/types.ts:34-74`: public get row's detailed shape; consume through RPC only, no private import.
- `plugins/quirky.agent-status/src/service.ts:134-150,280-281`: status event names and hooks; plugin changed events carry `sessionId,row`.
- `plugins/quirky.terminal/src/layout/types.ts:28-69`: workspace/group/tab/pane public response shape; use a local structural boundary type, not a runtime private import.
- `plugins/quirky.terminal/quirky-plugin.json:630-657,1207-1250,1682-1719`: workspace, focusPane and openExternal schemas.
- `plugins/quirky.session/src/window/model.ts:65-107`: subscription/report lifecycle pattern.
- `packages/protocol/src/ui.ts:184-238`: MountFunction, UiPluginContext and UI command contracts.
- `plugins/quirky.ask/quirky-plugin.json`: schema-declared panel/commands/CLI conventions.
- `plugins/quirky.agent-status/test/e2e/support.ts:28-151`: isolated real daemon/CLI/status hook harness; `startStatusE2E`, `cliJson`, `newSession`, `installAgents`, `waitFor`.
- `plugins/quirky.terminal/test/e2e-ui/features-support.ts:230-282`: real UI/API harness; `startFeatures`, `reportOf`, `openWorktreeView`.
- `packages/ui/test/fixtures/headless-window.ts:88-158`: connected real shell fixture.

## Contracts & interfaces
[Decisions](logic.md#decisions-locked), [scenarios](logic.md#behavior--scenarios).

### JSON launch argument composition
Extend `LaunchPatch` with optional `jsonArgs: Record<string, Record<string, unknown>>`; `LaunchHookInput` exposes the accumulated readonly `jsonArgs`. Keys are long option names such as `--settings`; values are JSON objects. Merge object keys recursively in hook-ID order, replace arrays/scalars at the leaf with the later value, reject invalid/non-JSON objects/prototype-dangerous keys consistently with patch validation. Preserve ordinary env/args ordering. Render exactly one option and serialized JSON object per composed JSON argument after ordinary extra args. Do not accidentally let one invalid jsonArgs field discard an otherwise valid earlier patch. Existing hooks without jsonArgs behave unchanged. Migrate Claude agent-status to contribute its version-gated hooks as jsonArgs rather than a separate file --settings. Update all actual callers/tests/documented settings output affected by that cutover; no obsolete compatibility writer.

User-supplied settings are part of this cutover, not just hook settings. Add public quirky.agents/settingsOverlay with params `{agent,cwd,record?,model?,options?,extraArgs?}` returning `{settings:object}`. Resolve launch arguments from current configuration/picks/extras for create or the supplied launch record for resume; parse --settings JSON, file paths relative to cwd, and --settings=value, honoring argument order and the -- terminator. Return combined user argument settings without hook overlays. Read failures/malformed files are visible invalid-params errors, never silently discarded. The agent launch and resume planner must use the same parser/merger to combine those user settings with hook JSON settings into exactly one effective --settings argument before any terminator; preserve the original replay record and unrelated tokens. Do not parse shell command text by naive splitting.

Extend public PluginLaunch.hooks input/LaunchHookInput with optional `record` (SessionLaunch, for resume), `model`, `options`, and `extraArgs` launch context; session create forwards picks/extras, resume forwards the original replay record. The session-info launch hook calls settingsOverlay with that context so consent sees the exact CLI-supplied statusLine that launch will use. Settings precedence is user-global, project, project-local, user CLI settings in order, then managed hook/consented telemetry contributions. Managed policy remains higher precedence. Effective consent must include CLI command edits and retained formatting fields. Existing absent-context callers behave unchanged.

### Authoritative terminal workspace focus
Add public quirky.terminal/focusContext, params `{workspace?:string|null}`, result `{workspace:string|null}`, and a declared focusContextChanged event. A supplied workspace records the last terminal workspace actually focused (worktree ID or floating); null clears it. Omitted workspace only reads. This is daemon-owned, transient focus authority; reset invalid/closed floating targets rather than retain phantom focus. Main workspace pane focus and explicit focusPane APIs update it; FloatingOverlay reports true terminal focus into it. Clicking the Session Info panel must not erase the last terminal focus. Producers must report actual terminal focus, not infer focus from overlay visibility. Session-info consumes this public state, validates the active view/floating visibility, then resolves that workspace's authoritative active group/tab/pane. Native focus/scroll-to-bottom effects stay routed through existing terminal UI commands.

Integration prerequisites for SC-7 and SC-32: `command:quirky.terminal/focus-pane` accepts `{pane:string,workspace?:string}`, activates the exact group/tab/pane, opens the terminal view, then focuses/flashes and scrolls that mounted pane to bottom. `quirky.terminal/openSession` accepts `{session:string,workspace?:string}` and returns `{workspace:Workspace,pane:string}`; it idempotently locates an existing session leaf or places the already-running local terminal session into a new tab without spawning a process. `command:quirky.terminal/open-session` uses that method then the focus-pane command. Session-info uses open-session after public session/resume returns. Nullable focusContext schema fields use Quirky's existing description-only schema convention with explicit handler validation; the public schema engine does not support a type array.

The registered main terminal root is `view:quirky.session/worktree` (the terminal plugin overrides that stable contribution). A view-name prefix is not a valid capability test; there is no registered terminal/workspace alias. Main focus without that visible root is empty. Focused floating inspection validates its overlay independently of the root underneath.

### Public plugin methods
All methods are declared in `plugins/quirky.session-info/quirky-plugin.json` with params/results and matching CLI commands. Namespace `quirky.session-info/*`, CLI group `session-info`.

- `get {session?:string}` returns the panel state below; without a selector resolve current authoritative focus. An explicit missing selector throws not-found; no focused agent returns info=null.
- `sections {open?:string[]}` reads or replaces the durable set. Allowed IDs identity, usage, liveActivity, context, filesTouched, hooksAndMcp. Initially `[liveActivity]`. Invalid names fail invalid-params. Return `{open:string[]}` and emit changed.
- `inspect {session?:string}` loads hook status, chain/consent status and MCP configuration independently, returning successful components even if another fails. Explicit Retry also refreshes usage; lazy UI call only when Hooks & MCP opens. No private cross-plugin store reads.
- `telemetry {session:string,payload:object}` uses the same guarded ingestion as authenticated hook events. Reject/ignore telemetry for non-Claude or mismatched provider IDs; do not let a statusline establish/replace the authoritative provider ID. Return `{accepted:boolean}`.
- `enableTelemetry {session?:string,enabled?:boolean}` defaults enabled=true; persist consent for the exact custom command identity, or opt-out. Return chain status and clear next-launch-effect text. Re-reading changed custom settings yields available/drifted instead of inheriting stale consent.
- `history {query?:string}` returns matching Session records via public session/list; query matches provider ID, Quirky ID/title. No transcript indexing.
- `transcript {session:string}` reads the recorded local transcript for display, bounded to 16 MiB; returns `{path:string,text:string}`. Missing/unreadable/oversized file is a visible domain error. Never accept an arbitrary user-supplied path.
- `resumeCommand {session:string,fork?:boolean}` returns `{command:string}` using public quirky.agents/prepareResume with the recorded launch, captured provider session, empty hookArgs/hookEnv and cwd; validate resumability/provider ID and surface existing domain failures. It does not start a process. UI copy-resume-command consumes this new method.

UI command contributions: `open`, `copy-id`, `open-history`, `focus-pane`, `open-transcript`, `reveal-transcript`, `resume`, `fork`, `copy-resume-command`. Except open, args optionally select `{session:string}` and otherwise resolve current state; history navigation uses provider ID as query. These are reachable through ui.command.run/CLI even for view-only actions. Clipboard actions require a window and surface clipboard errors; do not claim Copied on failure. Resume uses existing session/resume; copy-resume-command uses this plugin's resumeCommand method. Native reveal delegates public terminal/openExternal with reveal=true; transcript view uses transcript method rather than OS opening by default.

### Data models / schemas
Exact shared types live in `plugins/quirky.session-info/src/types.ts`; UI imports types only. Structural RPC boundary types remain local to the plugin.

SCHEMA:
- `SectionId = identity | usage | liveActivity | context | filesTouched | hooksAndMcp`.
- `PanelState = {session:string|null,pane:string|null,workspace:string|null,openSections:SectionId[],info:SessionInfo|null}`.
- `SessionInfo = {identity:Identity,liveActivity:LiveActivity,usage?:Usage,context?:Context,filesTouched?:FilesTouched,hooksAndMcp?:Inspection}`.
- `Identity = {agent:string,sessionId:string,providerSessionId:string|null,model?:string,pane:string|null,paneTitle?:string,worktreeId:string,cwd:string,startedAt:number,updatedAt:number,transcriptPath?:string,version?:string,outputStyle?:string,branch?:string}`.
- `LiveActivity = {state:string,label:string,toolName?:string,toolInput?:string,subagentCount:number,startedAt:number,updatedAt:number}`. Preserve interrupted/failed display rather than coarse done.
- `Usage = {status:waiting|ready,freshness?:fresh|refreshing|stale,totalTokens?:number,turnCount?:number,input?:number,output?:number,cacheRead?:number,cacheWrite?:number,updatedAt?:number,error?:string}`.
- `Context = {status:waiting|ready,usedPercentage?:number,remainingPercentage?:number,window?:number,used?:number,remaining?:number,estimated?:boolean,updatedAt?:number,planWindows?:{fiveHour?:PlanWindow,sevenDay?:PlanWindow}}`.
- `PlanWindow = {usedPercentage:number,resetsAt:number}`; source resets_at seconds normalize to milliseconds.
- `FilesTouched = {added?:number,removed?:number,updatedAt:number}`.
- `Inspection = {hooks?:{state:string,detail?:string},statusline?:{state:managed|chained|available|drifted|disabled|error,detail?:string},mcp:{name:string,transport:string,state:enabled|disabled|invalid}[],updatedAt:number,error?:string}`.

Absent optional fields stay absent; nonfinite/negative counters rejected; percentages bounded; no telemetry persisted. Cache key includes Quirky ID + provider ID, max 256 active snapshots; invalidation generation gates asynchronous scans and cleanup. Store only sections/consent preferences through openStore migrations. Broadcast declared changed event with a session identifier (or null for preference/focus invalidation); consumers refetch using coalesced generation-safe pulls rather than overwrite a newer push with an older snapshot.

### Claude collection and preservation
Statusline hook is supplied only for local agent `claude` (not Claude-shaped providers). Read effective relevant settings without writes: CLAUDE_CONFIG_DIR or HOME/.claude/settings.json, workspace settings and local settings in precedence order; managed policy must not be falsely claimed overridden. Preserve existing statusLine object keys. No custom command means managed telemetry unless explicit opt-out; custom command requires current-command consent before overlaying it.

For CLI-provided statusLine, call the new public agents/settingsOverlay using the session's replay record for existing sessions and full launch-hook context for new launches; apply it above file settings before checking command-specific consent. Preserve CLI statusLine object keys too. The actual agent planner uses the same resolver so inspection and execution cannot disagree.

Generate private wrapper assets under plugin dataDir with restrictive modes; absolute shell-quoted paths, no shell interpolation of payload. Pass identical JSON stdin to the original custom command once; print its stdout only on success; recursion guard; watchdog bounds it and its descendants. POST through existing hook URL/token env with source session-info-claude, resolve daemon runtime port after restarts, skip CLAUDE_JOB_DIR, handle context-only payloads, per-session elapsed-duration throttle 15 s. Failures never block the agent or print telemetry to stdout.

Subscribe to hook.received and status/session events. Lead Claude Stop (not sessionBoundary or subagent) triggers streaming/bounded transcript scan, filtering provider session and excluding sidechains; deduplicate streamed assistant updates by message identity so usage isn't counted twice. Keep last good values on errors, mark refreshing/stale, truncate errors to 500 chars. Fallback last assistant context estimates a 200000 window and is labeled estimated; statusline context takes precedence. Model precedence is statusline display_name, status row, transcript. Plan windows only from the same accepted payload, missing windows do not persist after a newer rate_limits object removes them.

MCP inspection reads local known Claude configuration scopes (workspace .mcp.json, workspace Claude settings/local settings, user Claude config/settings, provider config where supported); deduplicate first scope by name. Identify stdio/http/sse or invalid entries; honor disabled/enabled server names. Never execute MCP server commands or read secrets into results. Independent parse errors remain visible without hiding successfully inspected components.

## DO-NOT-CHANGE fences
[Non-goals](logic.md#scope--non-goals).
- `docs/loop/LOOP.md`, `scripts/build-loop/`, queue.json and DECISIONS.md: protected/shared state controlled by queue.ts only.
- User ~/.claude, ~/.codex and ~/.quirky: never write during feature implementation or tests. Per-launch overlays only; every process test uses isolated QUIRKY_HOME and HOME and cleans up.
- Kernel server auth and hook token validation in server.ts: reuse existing transport; no unauthenticated telemetry endpoint.
- Agent-status state folding/capture rules: session-info consumes public status, never changes status semantics or establishes provider ownership from telemetry.
- Existing UI slot host/shell structure: use public contributions, not DOM poking or second panel conventions.

## Always / Ask / Never
[Locked behavior](logic.md#decisions-locked).
- Always: namespaced declared schemas, public API calls, daemon authority, bounded reads/cache, exact ID correlation, UI lifecycle cleanup and visible errors.
- Ask: no human asks under LOOP.md; record recommended defaults. A conflict with a locked decision formally blocks the item.
- Never: private service imports, global settings writes, arbitrary telemetry-to-file reads, silently reduced scope, model fabricated zeros, remote telemetry masquerading as local.

## Cross-cutting
[Data flow](logic.md#data-flow), [scope](logic.md#scope--non-goals).
Security: hook auth unchanged; no secrets/payloads in logs, minimal parsed fields. Transcript paths come from session capture; reads bounded and nonblocking. Configuration consent hashed to the effective command; launch rechecks settings, no stale-file restoration. Native APIs called only on explicit actions. No new persistent telemetry tables; rollback disables plugin/launch contribution and leaves user config intact. Linux/Windows process-tree watchdog/launchers deferred by platform decision.

## Testing strategy
[Acceptance criteria](logic.md#behavior--scenarios).

- Launch slice owns protocol/daemon launch tests and affected agent-status settings tests; assert effective JSON args (hooks plus statusline), invalid patch isolation, ordinary launch behavior unchanged, create/resume coverage.
- Backend owns `plugins/quirky.session-info/test/api.test.ts` plus test support files. Use real daemon/CLI/status harness for every SC-1–33 API side; add narrowly focused deterministic tests only for scan races, parser/runner boundaries/cache eviction impractical through real sessions. Test custom script stdout/stdin and elapsed throttle as subprocesses with temporary homes; kill all spawned groups.
- UI owns `plugins/quirky.session-info/test/ui.test.tsx` and `test/e2e-ui/*`; drive actual public API/routed commands and mounted shell for focus changes, neutral/waiting/ready/stale state, sections persistence, clipboard success/failure, history/resume/transcript and command availability. Use existing headless-window/features harness. No source text/default-only assertions.
- Required commands: `bun test plugins/quirky.session-info/test/api.test.ts`; `bun test plugins/quirky.session-info/test/ui.test.tsx`; `bun run build`; `bun run test`; `bun test scripts`; `bun run typecheck`. Only bun run test runs the full suite (remote host).
- Final real web dogfood uses temporary HOME/QUIRKY_HOME daemon and likeuser.py --surface web --owner yours --unattended. Exercise all visible scenario categories, preserve report path/summary. Finder and OS clipboard/focus effects use `docs/loop/native/m3-session-info.json` pending scenarios.

## Non-goals
See [logic scope](logic.md#scope--non-goals). This spec does not introduce a general MCP runtime, account scanner, vault indexer, remote execution transport or separate native application shell.
