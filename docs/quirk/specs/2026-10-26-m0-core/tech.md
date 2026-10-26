# m0-core tech spec

**Status:** Draft for build. **Logic spec:** [logic.md](logic.md). **Decisions:** [m0-core.md](../../../loop/decisions/m0-core.md).

All paths are relative to the repo root `/Users/zpyoung/orca/workspaces/quirky/build-roadmap`.
"v1 schema of X" means the entry for X in `packages/protocol/src/kernel-schemas.ts`
`KERNEL_METHOD_SCHEMAS` (:228-532) as it is at the start of this item.

## Architecture

Four layers change. Each later layer depends only on the contracts of the earlier ones.

1. **Protocol** (`packages/protocol/src`): kernel-only `Methods`, protocol version 2, new kernel
   methods and events, the plugin context and caller additions, manifest additions, the CLI
   plugin contract, UI layout and distro types, and the socket path rule.
2. **Kernel** (`packages/daemon/src`): a unix-socket transport beside the WebSocket; a dispatcher
   pipeline with request IDs and confirmations; the grown plugin context; the layout service and
   routed UI commands; plugin install, distros and safe mode; the hook endpoint as an event. `Core`
   (`service.ts`) shrinks to client bookkeeping, broadcast and status, and every v1 feature leaves it.
3. **Built-in plugins** (`plugins/quirky.*`): eight workspace packages, each with a manifest, a
   daemon `main.ts`, optionally a `cli.ts` and a `src/ui.tsx` built to `dist/ui.js`, and tests.
4. **Clients**: the CLI (`packages/cli`) over the socket with plugin CLI commands; the window
   (`packages/ui`) rendering the daemon's layout and hosting the built-ins' UI modules; the desktop
   shell (`apps/desktop`) on the new event and method names.

Libraries stay as they are: Bun 1.4, `bun:sqlite`, React 19, xterm 5.5, `@codemirror/merge`,
`@anthropic-ai/claude-agent-sdk` 0.3.284 (moves from `packages/daemon` to `plugins/quirky.structured`).
New dev dependency: `@happy-dom/global-registrator` in `packages/ui`, pinned to an exact version
published at least two weeks before it is added, for the headless-window tests.

Root `package.json`: `workspaces` gains `"plugins/*"`; `test` becomes `bun test packages apps plugins`.
`.gitignore` gains `plugins/*/dist/`.

## Code references

### Protocol (`packages/protocol/src`)

| File | Change |
|---|---|
| `rpc.ts` | `PROTOCOL_VERSION = 2`. Remove from `Methods` every v1 feature method (`settings.*`, `repo.*`, `worktree.*`, `session.*`, `terminal.*`, `git.*`, `ask.*`, `structured.*`) and their `QuirkyEvent` members (`repo.changed`, `worktree.changed`, `session.changed`, `session.removed`, `git.changed`, `ask.created`, `ask.resolved`, `structured.message`). Add the kernel methods and events of [Kernel methods](#kernel-methods) and [Kernel events](#kernel-events). `RpcRequest` gains `requestId?: string`. `RpcErrorCode.ConfirmationRequired = -32010`. |
| `kernel-schemas.ts` | Schema entries for every new kernel method and event; remove the v1 entries (their schemas move into the plugins' manifests, renamed as below). The entry type at :532 gains `readOnly?: true` and `destructive?: { confirm: string }`. `CONNECTION_METHODS` becomes `['client.hello', 'events.subscribe', 'ui.report', 'ui.window.focused', 'ui.command.reply']`. |
| `catalog.ts` | `ApiMethodEntry` gains `readOnly?: true`, `destructive?: true`, `confirm?: string`; plugin entries carry `connection` too. `ApiDescription` gains `cli: { groups: ApiCliGroup[]; commands: ApiCliCommandEntry[] }`. `CATALOG_SCHEMA_VERSION = 2`. |
| `plugins.ts` | `PluginContext` gains `home`, `pty`, `notify`, `launch` (see [Plugin context](#plugin-context)). `PluginCaller` gains the connection caller fields. `PluginManifest` gains `cli?: string` and `cliAliases?: string[]`. `ContributionInfo.disabledBy` gains `'distro'`. `PluginInfo` gains `cliAliases?: string[]` and `disabledReason?: 'user' \| 'distro' \| 'safe-mode' \| 'dependency'`. |
| `ui.ts` | `UiLayout`, `UiState`, `UiSlotState`, `UiWindowInfo`; `MountFunction` props gain `report`; `UiPluginContext` gains `getLayout`, `onLayout`, `onStream`, `onConnection`, `confirm`, `toast`, `setPanelBadge`; `openView`/`closeView`/`togglePanel` become daemon calls. Remove `mod+t`, `mod+w` and `mod+1`..`mod+9` from `RESERVED_CHORDS` (they become `quirky.session` keybindings); `mod+shift+p` stays. |
| `model.ts` | Remove `Settings`. Everything else stays (Repo, Worktree, Session, Ask*, Git*, StructuredMessage). |
| `cli.ts` (new) | The plugin CLI module contract, [CLI plugin contract](#cli-plugin-contract). Exported from `index.ts`. |
| `distro.ts` (new) | `DistroManifest`, `DistroInfo`, `PluginInspection`, `DistroInspection`, and `parseDistroManifest` (pure, used by the daemon). |
| `schema.ts` | `RESERVED_FLAG_NAMES` (:18) gains `yes`, `retry-request`, `version`, `confirmation`. |
| `client.ts` | Factor the JSON-RPC core out of the WebSocket transport. `QuirkyClient.connect(url, hello)` keeps the WebSocket; new `QuirkyClient.connectSocket(path, hello)` uses `Bun.connect({ unix })` with newline-delimited JSON. `call`/`callAny` take an optional third arg `{ requestId?: string }`. A dropped connection rejects pending calls with `ConnectionLost` (new exported class), distinct from `RpcError`. Hello carries `token`, `cwd`, `sessionId`, `worktreeId` when given. |
| `node/index.ts` | `RuntimeInfo` gains `socket: string`. New `socketPath(home, name)` ([Socket path rule](#socket-path-rule)). `connectDaemon` gains `transport?: 'socket' \| 'websocket'` (default `websocket`; the CLI passes `socket`) and `identity?: { cwd?, sessionId?, worktreeId? }`. `ensureDaemon` gains `args?: string[]` passed to the daemon entry. |

### Kernel (`packages/daemon/src`)

| File | Change |
|---|---|
| `server.ts` | Extract `handleMessage` (:123) into `rpc-handler.ts` shared by both transports. Accept `requestId` (string, 1-128 chars, else InvalidRequest) and pass it to the dispatcher. `fail` sends `error.data` when the `DaemonError` has it. Hook endpoint (:48): after the token check, deliver `hook.received` to plugins and answer `{ ok: true }` (no more 404 for an unknown session). |
| `socket-server.ts` (new) | `startSocketServer({ path, rpcToken, core, handle })`: `Bun.listen({ unix })`, unlinks a stale file first, chmods 0600, frames by `\n`, refuses lines over 16 MiB (closes), builds a `ClientConn` with `transport: 'socket'`, requires the first message to be `client.hello` with the right `token` (else Unauthorized and close). `sendBinary` throws. |
| `types.ts` | `ClientConn` gains `transport: 'websocket' \| 'socket'`, `cwd?`, `sessionId?`, `worktreeId?`, `focusedAt?: number`, `streamClosers: Map<number, () => void>`. `streams` becomes `Map<number, string>` owned by the stream helper. |
| `errors.ts` | `DaemonError` gains optional `data`. New `confirmationRequired(data)`. |
| `daemon.ts` | Wire the socket server (path from `socketPath(home, 'quirkyd.sock')`) and write `socket` into `runtime.json`; new options `safeMode?: boolean`, `socketPath?: string`; stop the socket server in `stop()`. Remove `git`, `runnerFactory`, `resolveClaudePath`, `enterDelayMs` from `DaemonOptions` (they move to plugin seams, [Test seams](#test-seams)). Keep `notifier`, `shell`, `cliEntry`, `ptyHostEntry`. |
| `main.ts` | Parse `--disable-plugins` and `QUIRKY_DISABLE_PLUGINS=1` into `safeMode`. |
| `methods.ts` | Remove v1 handlers; add handlers for the new kernel methods. `describeApi` (:98) emits `readOnly`, `destructive`, `confirm`, `connection` for kernel and plugin methods, and the `cli` section. |
| `service.ts` | `Core` keeps `addClient`, `removeClient`, `broadcast`, `sendTo(conn, event)`, `clients()`, `status()` (+ `safeMode`, `socket`), `hookToken`, `home`. Everything else moves to the plugins. `resolveRealPath`/`worktreeIdForPath` move to `plugins/quirky.worktree`. |
| `store.ts` | Drop nothing (v1 tables stay for D14's import). Remove the v1 accessors once their plugins own the data. Add tables `request_log`, `confirmations`, `distro` ([Data models](#data-models)). The layout lives in `ui_state` under key `layout`. |
| `launch.ts` | Keep the kernel half: `installIntegrationFiles` (writes `bin/quirky`, `bin/quirky-hook`, shell wrappers; no longer the Claude settings file), `buildSessionEnv`, `shellQuote`, wrapper paths, and a new `shellArgv(home, shell)` and `commandArgv(home, shell, command)` (the two branches of `buildArgv`). Agent command strings (`claude`, `codex -c notify`, `opencode --prompt`, `gemini --prompt-interactive`) and `AGENT_TITLES` move to `quirky.session`; `claudeSettings*` and the hook mapping move to `quirky.agent-status`. |
| `hooks.ts`, `asks.ts`, `git/`, `git-api.ts`, `structured/` | Move to their plugins (below) and are deleted here. `notify.ts` stays (kernel). |
| `plugins/dispatch.ts` | The pipeline of [Dispatch pipeline](#dispatch-pipeline). `DispatchSource` gains `{ kernel: true }`. |
| `plugins/requests.ts` (new) | `RequestLog` (request-ID records and in-flight joins). |
| `plugins/confirm.ts` (new) | `Confirmations` (create the ask, check a confirmation, mark it used). |
| `plugins/runtime.ts` | `extension.create` adds `home`, `pty`, `notify`, `launch`; connection streams in `callerOf`. `hook.received` delivery. |
| `plugins/pty-api.ts` (new) | `createPtyApi(pty: PtyClient, pluginId)` implementing `PluginContext['pty']`; listeners are removed on revoke. |
| `plugins/streams.ts` (new) | `openStream(conn)` for `connection: true` plugin methods; closes streams on disconnect. |
| `plugins/host.ts` | `PluginHostOptions` gains `safeMode: boolean` and `distroDisabled(): string[]`. `recompute()` (:210) filters to built-ins and passes an empty user set in safe mode, else `user ∪ distro`, tagging distro disables. New `rescan()` (re-run discovery, recompute, deactivate plugins that vanished or changed version, broadcast `plugin.changed`). `ContextExtension` `Pick` (:19-30) widens to the new members. `FUNCTION_KINDS` (:54) unchanged (`cli-command` code lives in the CLI, not the daemon). |
| `plugins/registry.ts` | `computeRegistry(discovered, disabled, distroDisabled?)` marks distro-disabled entries with `disabledBy: 'distro'` and plugins with reason `distro`. |
| `plugins/manifest.ts` | `FIELDS` (:15) gains `cli`, `cliAliases`; `cli` checked like `main` (`checkPluginPath`); `cliAliases` is a list of distinct words matching `^[a-z][a-z0-9-]*$`. |
| `plugins/kinds.ts` | `ALLOWED_FIELDS.method` (:7) gains `readOnly`, `destructive`, `confirm`, `connection`; new kind `cli-command` ([Manifest additions](#manifest-additions)). |
| `plugins/ui-model.ts` | `buildUiModel` input gains `distroKeybindings: { key: string; command: string }[]` and `distroId: string \| null`; those bindings get IDs `keybinding:<distroId>/k<n>` and beat every non-kernel binding on their chord; a distro binding on a reserved chord is `shadowed` by the kernel, and `distro.inspect`/`install` warn about it. |
| `plugins/ui-service.ts` | Setting value precedence user, distro, default, with `SettingInfo.source`; theme chosen user, distro, default; both skip the distro in safe mode. |
| `plugins/layout.ts` (new) | `LayoutService` ([Layout and windows](#layout-and-windows)). |
| `plugins/install.ts` (new) | `inspectPlugin`, `installPlugin`, `uninstallPlugin`. |
| `plugins/distros.ts` (new) | `DistroService`: inspect, install, list, remove; the layer it feeds to host, UI service and UI model. |

### Built-in plugins (`plugins/`)

Each is a directory named by its ID with `package.json` (name `@quirky/plugin-<feature>`,
`private`, `type: module`, dependencies `@quirky/protocol: workspace:*` plus what it imports),
`quirky-plugin.json`, `main.ts`, optional `cli.ts`, optional `src/ui.tsx`, and `test/`. Source
moves from the daemon as listed; it imports only `@quirky/protocol`, its own files, Bun and Node
built-ins and its declared packages.

| Plugin | Takes from | Activation |
|---|---|---|
| `quirky.repo` | `service.ts` repo methods, `store.ts` repos table, `cli/src/commands/repo.ts` | lazy |
| `quirky.worktree` | `service.ts` worktree methods and helpers (:220-284, :689-750), `resolveRealPath`, `worktreeIdForPath`, `git/` worktree functions, `cli/src/commands/worktree.ts`, `support.ts` cwd matching, `ui/src/components/Sidebar.tsx`, `NewWorktreeDialog.tsx`, `lib/status.ts` | lazy |
| `quirky.session` | `service.ts` session lifecycle (:286-412, :541-554, :565-600), `launch.ts` agent commands and `AGENT_TITLES`, `cli/src/commands/session.ts`, `ui/src/components/SessionTabs.tsx`, `SessionView.tsx`, `NewSessionMenu.tsx`, `PromptDialog.tsx`, `terminal/`, `structured/StructuredView.tsx`, `MessageRow.tsx`, `lib/transcript.ts`, `lib/replayGate.ts`, `lib/terminalTheme.ts`, `lib/shortcuts.ts`, `useShortcuts.ts` (the session shortcuts) | startup |
| `quirky.terminal` | `service.ts` terminal I/O (:414-486, :620-688), `cli/src/commands/term.ts` | lazy |
| `quirky.agent-status` | `hooks.ts`, `service.ts` `handleHook`/`setSessionStatus`/notify call (:530-539, :577-612), `launch.ts` `claudeSettings*` | startup |
| `quirky.git` | `git/` status/diff/stage/unstage/commit, `service.ts` git methods (:488-510, :556-563), `ui/src/scm/`, `lib/scm.ts`, `lib/diffRefresh.ts`, `lib/diffText.ts`, `lib/language.ts` | lazy |
| `quirky.ask` | `asks.ts`, `store.ts` asks table, `cli/src/commands/ask.ts`, `spec.ts`, `ui/src/asks/`, `lib/askAnswers.ts` | lazy |
| `quirky.structured` | `structured/`, `service.ts` structured methods (:363-392, :512-528, :614-619), `store.ts` structured_messages | lazy |

### Clients

| File | Change |
|---|---|
| `packages/cli/src/main.ts` | `--version`/`-v` before routing; `connectDaemon({ role: 'cli', transport: 'socket', identity })`; routing over kernel, plugin `cli-command` and generated commands with group aliases; confirmation and request-ID handling through the link. |
| `packages/cli/src/link.ts` | `createDaemonLink(connect, { requestBase, yes, isDestructive })`: request IDs, lost-reply retry, `--yes`, the confirmation wait. |
| `packages/cli/src/args.ts` | `GLOBAL_FLAGS` (:28) gains `yes` (boolean) and `retry-request` (string). |
| `packages/cli/src/commands/index.ts` | `COMMANDS` loses repo, wt, session, term, ask; gains `ui state|open-view|close-view|open-panel|close-panel|sidebar|focus|run`, `plugin inspect|install|uninstall`, `distro inspect|install|list|remove`, `daemon restart`. `GLOBAL_TOKENS` (:72) gains `--yes`, `--version`, `-v`. |
| `packages/cli/src/plugin-commands.ts` (new) | Builds `Command`s from `ApiDescription.cli`: declared commands (generic or module-backed) and alias words; imports a plugin `cli` module only when its command runs. |
| `packages/cli/src/catalog.ts` | `resolveCommands(kernel, declared, generated)`: kernel, then a plugin's declared commands, then generated; a plugin's declared command beats its own generated command on equal words; alias words follow the same precedence. |
| `packages/cli/src/commands/{repo,worktree,session,term,ask,spec,support}.ts` | Move into the plugins' `cli.ts` (formatters through the context). |
| `packages/ui/src/App.tsx`, `components/MainArea.tsx`, `Sidebar.tsx` | The shell renders the layout: sidebar sections (when `layout.sidebar`), the open view, the open panel. v1 surfaces are gone from the shell. Header shows the selected worktree only through the view's report, so it shows the view's title. |
| `packages/ui/src/plugins/host.ts` | Layout mirror from `ui.state`/`ui.state.changed`; `openView`/`closeView`/`togglePanel` call the layout methods; routed command handling; slot reports; context additions. `runCommand` gains a variant `runCommandForResult(id, args)` that returns the result or throws. |
| `packages/ui/src/connection.ts`, `lib/state.ts`, `actions.ts`, `lib/persist.ts` | Drop v1 snapshot loading, reducer cases and selection persistence (the daemon owns them). Keep connection status, toasts, epoch. |
| `packages/ui/src/components/SettingsDialog.tsx` | Only plugin settings and themes (no `settings.set`). |
| `packages/ui/src/components/Toasts.tsx` | Click opens the notify event's `open` target through `ui.view.open`. |
| `packages/ui/build.ts` | Also bundles each `plugins/*/src/ui.tsx` to `plugins/*/dist/ui.js` (same externals as the app, `target: browser`). |
| `apps/desktop/src/bun/events.ts`, `index.ts` | Native notification only for `notify` events with `desktop: true`. Badge from `quirky.session/list` and `quirky.ask/list` (a MethodNotFound counts 0); refresh on `quirky.session/changed`, `quirky.session/removed`, `quirky.ask/created`, `quirky.ask/resolved`. |
| `apps/desktop/scripts/bundle.ts` | Copies `plugins/` into `resources/plugins`, bundling each built-in's `main.ts` and `cli.ts` with its dependencies into `.js` beside it and rewriting the copied manifest's `main`/`cli` to the `.js` names; copies `dist/ui.js`. |
| `distros/sample/` (new) | `quirky-distro.json` and plugin `sample.sidebar` ([Sample distro](#sample-distro)). |

## Contracts & interfaces

### Socket path rule

Back-links: SC-3, D16, D17.

- `socketPath(home, name)`: `join(home, name)` when its UTF-8 length is at most 100 bytes; else
  `/tmp/quirky-<uid>/<first 16 hex of sha256(realpath(home))>-<name>`. The directory is created
  0700; if it exists and is not owned by the user or is not 0700, throw naming the path.
- Used for `quirkyd.sock` (daemon) and `pty.sock` (PTY host server in `packages/pty-host/src`,
  `PtyClient` in `packages/daemon/src/pty-client.ts`, and `packages/daemon/test/fixtures/fake-pty-host.ts`).

### Kernel methods

Back-links: SC-1..SC-16, SC-35..SC-58. Schemas live in `kernel-schemas.ts`. RO = `readOnly`, D = destructive (with its `confirm` text), C = connection.

`CONTRACT:`
```
client.hello        C   {role, name?, protocolVersion, token?, cwd?, sessionId?, worktreeId?} -> {protocolVersion, daemonVersion}
status.get          RO  {} -> {...v1 fields, safeMode: boolean, socket: string}
daemon.stop             {} -> {ok}            // replies, then stops the daemon (not the PTY host)
plugin.inspect      RO  {path} -> PluginInspection
plugin.install      D   {path} -> PluginInfo                 confirm: "Install plugin {path}?" (+ listing, below)
plugin.uninstall    D   {id} -> {ok}                         confirm: "Uninstall plugin {id}?"
distro.inspect      RO  {path} -> DistroInspection
distro.install      D   {path} -> DistroInfo                 confirm: "Install distro {path}?" (+ listing)
distro.list         RO  {} -> DistroInfo[]
distro.remove       D   {id} -> {ok}                         confirm: "Remove distro {id}?"
ui.state            RO  {} -> UiState
ui.view.open            {id, input?} -> UiLayout             // id must be an effective view; input JSON <= 64 KiB
ui.view.close           {} -> UiLayout
ui.panel.open           {id} -> UiLayout                     // id must be an effective panel
ui.panel.close          {} -> UiLayout
ui.sidebar.set          {visible: boolean} -> UiLayout
ui.focus                {target: 'sidebar'|'view'|'panel'} -> UiLayout
ui.command.run          {id, args?} -> {result: unknown}
ui.report           C   {slot, state: unknown|null} -> {ok}  // role ui only
ui.window.focused   C   {focused: boolean} -> {ok}           // role ui only
ui.command.reply    C   {requestId, result?, error?: {message}} -> {ok}  // role ui only
```
Unchanged kernel methods keep their schemas; `plugin.list`, `plugin.contributions`,
`api.describe`, `job.list`, `ui.contributions`, `setting.list`, `setting.get`, `theme.list` become RO.

For `plugin.install` and `distro.install` the confirm text is the method's `confirm` with the
listing appended after a blank line: the inspection rendered as the lines of SC-49 (for a
reinstall, `id old → new` and `+`/`-` lines per added or removed contribution).

### Kernel events

`CONTRACT:`
```
{type: 'ui.state.changed', layout: UiLayout}                       // broadcast on every layout change
{type: 'ui.command.request', requestId, id, args}                  // sent only to the target window
{type: 'hook.received', agent, sessionId, payload}                 // delivered to plugin listeners only, never to clients
{type: 'notify', title, body, sessionId?, worktreeId?, open?: {view, input?}, desktop: boolean}   // `open` and `desktop` are new; the desktop shell shows a native notification only when `desktop` is true
```
`plugin.changed`, `setting.changed`, `theme.changed` and plugin events are unchanged.

### Dispatch pipeline

Back-links: SC-11..SC-14, SC-43..SC-48, D19, D20.

`Dispatcher.dispatch(method, params, from, options?: { requestId?: string })` does, in order:

1. Find the method (kernel table or effective `method:` contribution); unknown is MethodNotFound.
2. For a destructive method, take `yes` and `confirmation` out of params (any other method keeps
   them, so its schema rejects them).
3. Validate the remaining params against the schema (InvalidParams).
4. If `from` is a connection, `options.requestId` is set and the method is not RO and not C: look
   up the request log. Same ID and digest recorded: return or rethrow the recorded outcome. Same ID
   running: await it. Same ID, other digest: Conflict `request ID reused with different params`.
   Otherwise record the outcome when the call settles (results and every error, including
   ConfirmationRequired).
5. For a destructive method: `yes === true` runs it. A `confirmation` runs it only if
   `Confirmations.consume(askId, method, digest)` succeeds (ask answered `confirm: true`, same
   method and digest, unused), else Conflict naming the reason (`confirmation is for another
   call`, `confirmation already used`, `declined`, `confirmation not answered yet`). Neither:
   `Confirmations.request(method, params, action)` calls `quirky.ask/create` with source
   `{ kernel: true }` and throws ConfirmationRequired with data `{ askId, action }`; if
   `quirky.ask/create` is MethodNotFound, throw Conflict `this action needs confirmation and asks
   are off; pass --yes`.
6. Run the handler. Plugin handlers get `callerOf(from)`.

Request-log digest: sha256 of `method + "\n" + canonical JSON of params` (keys sorted), computed
after step 2. **Action text:** when the method declares `describe`, the kernel calls that method
with the same params and caller (it must return a string), else it fills the `confirm` text's
`{name}` placeholders with `String(params[name])`. **Confirmation digest:** sha256 of method,
canonical params, the caller's `cwd`, `sessionId` and `worktreeId`, and the action text, so a
confirmation never carries to another caller or to a selector that resolves elsewhere.
`quirky.worktree/remove` declares `describe: "describeRemove"` (returns `Remove worktree <name>
(<path>)?`, and `--force` adds `, discarding uncommitted changes`).

### Plugin context

Back-links: D11, D12, SC-22..SC-24.

`CONTRACT:`
```
PluginContext += {
  readonly home: string
  readonly pty: {
    readonly connected: boolean
    spawn(sessionId, {argv, cwd, env, cols, rows}): Promise<{pid}>
    write(sessionId, data: string | Uint8Array): void
    resize(sessionId, cols, rows): Promise<void>
    read(sessionId, lines): Promise<{lines, cols, rows, alt}>
    kill(sessionId, signal?): Promise<void>
    forget(sessionId): Promise<void>
    list(): Promise<PtySessionInfo[]>
    subscribe(sessionId): Promise<{replay: string, offset: number}>   // PTY 'subscribe'
    unsubscribe(sessionId): Promise<void>
    onData(listener(sessionId, bytes)): () => void
    onExit(listener(sessionId, exitCode)): () => void
    onReconnect(listener()): () => void
  }
  notify(n: {title, body, sessionId?, worktreeId?, open?: {view, input?}, desktop?: boolean}): void
     // broadcasts `notify` with desktop = (n.desktop !== false); with no desktop client connected and desktop true, runs the kernel notifier
  readonly launch: {
    readonly shell: string
    readonly binDir: string
    env(input: {sessionId, worktreeId, agent, envPatch?}): Record<string, string>   // buildSessionEnv; reserved names in envPatch are dropped
    shellArgv(): string[]
    commandArgv(command: string): string[]
    hooks(input: {sessionId, worktreeId, repoId, cwd, agent, prompt?}): Promise<{env, args}>  // runLaunchHooks
  }
}
PluginCaller (connection) = {role, name?, cwd?, sessionId?, worktreeId?,
  connection?: {id: number, transport: 'websocket'|'socket', openStream(): ClientStream}}   // connection set only for C methods
ClientStream = {readonly streamId: number, send(bytes: Uint8Array): void, onClose(cb): void, close(): void}
```
- `openStream` on a socket connection throws InvalidParams `this method needs the WebSocket transport`.
- A plugin method declared `connection: true` called through `context.call` is InvalidParams
  `<method> needs a client connection`, as kernel connection methods are.
- Every listener a plugin registers is removed when it is revoked.

### Manifest additions

Back-links: D8, D9, D20, SC-17, SC-48.

`SCHEMA:`
```
method entry  += readOnly?: boolean, destructive?: boolean, confirm?: string (required when destructive),
                 describe?: string (a readOnly method of the same plugin; destructive only), connection?: boolean
cli-command entry = {
  id: string,                       // contribution name
  words?: string,                   // relative to the group; default = id; "" is the bare group command
  summary: string,
  method?: string,                  // short name in the plugin's namespace or a full <pluginId>/<name>
  positionals?: [{name, description, required?: boolean, param?: string}],
  flags?: { [flag]: {type: 'string'|'integer'|'number'|'boolean'|'json', description, required?, repeatable?, enum?, param?} },
  methods?: string[]                // every wire name the run code may call; defaults to [method]
}
manifest += cli?: string (relative path), cliAliases?: string[]
```
Rules: a `cli-command` without `method` needs `cli` in the manifest; with `method` and no `flags`,
flags derive from the method's params as generated commands do; `positionals[].param` defaults to
the positional's name; words must be distinct within a plugin; flag names may not be reserved.

### CLI plugin contract

Back-links: D9, SC-20, SC-21, SC-28.

`CONTRACT:` (`packages/protocol/src/cli.ts`)
```
CliModule = { commands: Record<cliCommandName, (args: {positionals: string[], flags: Record<string, unknown>}, ctx: CliContext) => Promise<void>> }
CliContext = {
  call(method, params?): Promise<unknown>        // through the link: request IDs, --yes, confirmations
  out: {json: boolean, result(value, text: () => string), line(text), jsonLine(value)}
  format: {table(headers, rows), record(pairs)}
  env, cwd, readFile(path), sleep(ms), now(),
  usage(message): Error                          // exit 2
  fail(message): Error                           // exit 1, message on stderr only
  reconnect(): Promise<void>
}
```
The CLI imports the module from the absolute path in `ApiCliCommandEntry.module` with dynamic
`import()`, only after routing picked that command.

`SCHEMA:` (`catalog.ts`)
```
ApiCliGroup = {plugin, words: string, aliases: string[]}           // aliases after collision checks
ApiCliCommandEntry = {id, plugin, words: string, aliasWords: string[], summary, positionals, flags,
                      method: string | null, methods: string[], module: string | null}
```

### Selectors

Back-links: D10, SC-7..SC-10.

- `quirky.repo/resolve {selector}` RO -> Repo. `quirky.worktree/resolve {selector, cwd?, worktreeId?}` RO -> Worktree.
- Plugins resolve `repo`/`worktree` params by calling these with the caller's `cwd` and `worktreeId`.
- Order for a bare value: exact ID, then name, then (worktrees) branch. `path:` matches the
  innermost worktree containing the path, comparing real paths and literal paths, as
  `cli/src/commands/support.ts:43` does today.
- No match: NotFound `no worktree matches <selector>; use id:, name:, branch:, path: or current`
  (repo: `id:, name: or path:`). Several: Conflict `<selector> matches <n> worktrees: id:<a>, id:<b>`
  with `data: { matches: ['id:<a>', ...] }`.

### Built-in manifests

Back-links: SC-17, SC-18, SC-25, D5, D13. Params are the v1 schema of the old name with these
renames: `repoId` becomes `repo` (repo selector), `worktreeId` becomes `worktree` (worktree
selector), `sessionId` becomes `session`. "(cur)" marks a `worktree` or `session` that is optional
and defaults to the caller's.

| Plugin | Methods | Events | Other contributions |
|---|---|---|---|
| `quirky.repo` | `list` RO; `add {path}`; `remove {repo}`; `resolve {selector}` RO | `changed {}` | cli: `add <path>`, `list`, `rm <repo>` |
| `quirky.worktree` | `list {repo?}` RO; `create {repo, name, baseRef?}`; `remove {worktree, force?}` D "Remove worktree {worktree}?" with `describe: describeRemove`; `describeRemove {worktree, force?}` RO; `resolve` RO | `changed {repoId}` | sidebar-section `worktrees` (title "Worktrees", order 0); setting `worktreesRoot` string default `~/quirky/workspaces`; cli: `list [--repo]`, `create <repo> <name> [--base]`, `rm <worktree> [--force]`; `cliAliases: ["wt"]` |
| `quirky.session` | `list {worktree?}` RO (omitted = all); `get {session}` RO; `create {worktree (cur), agent, prompt?, cols?, rows?}`; `register {worktree (cur), agent, kind: "structured", title}`; `close {session}`; `setStatus {session, status, exitCode?}` | `changed {session}`, `removed {sessionId}` | view `worktree` (title "Sessions"); commands `new-shell`, `close-session`, `select-tab` (args `{index: integer}`); keybindings `mod+t`, `mod+w`, `mod+1`..`mod+9`; cli: `list [--worktree]`, `new --agent [--worktree] [--prompt] [--background]`, `close <session>` |
| `quirky.terminal` | `attach {session, cols, rows}` C; `detach {streamId}` C; `write {session, data}`; `resize {session, cols, rows}`; `send {session (cur), text, enter?}`; `read {session (cur), lines?}` RO | none | setting `scrollback` number 500..10000 default 2000; cli: `read [<session>] [--lines]`, `send [<session>] <text> [--enter]`; `cliAliases: ["term"]` |
| `quirky.agent-status` | `list {worktree?}` RO -> `[{sessionId, agent, status, lastHookAt}]` | none | setting `notifications` boolean default true; launch-hook `agent-hooks` (agents `claude`, `codex`) |
| `quirky.git` | `status {worktree (cur)}` RO; `diff {worktree (cur), path, staged?}` RO; `stage {worktree (cur), paths}`; `unstage`; `commit {worktree (cur), message}` | `changed {worktreeId}` | panel `source-control` (title "Source control") |
| `quirky.ask` | `create {spec, session?, worktree?}` (defaults from the caller); `wait {askId, timeoutMs?}` RO; `answer {askId, answers, skipped?}`; `cancel {askId}`; `list {pendingOnly?}` RO | `created {ask}`, `resolved {askId, envelope}` | panel `questions` (title "Questions"); cli: `` (bare: `--spec`, `--timeout-ms`), `wait --id [--timeout-ms]`, `cancel --id` |
| `quirky.structured` | `create {worktree (cur), agent, prompt}`; `messages {session, afterSeq?}` RO; `send {session, text}` | `message {message}` | none |

Dependencies as in the logic spec's table. Every daemon `main.ts` exports `activate(context)` and
provides one implementation per declared method, event-free contributions included.

Behavior carried over unchanged from v1 (with the file it comes from): worktree creation paths,
branch reuse and dirty-remove Conflict (`service.ts:235-284`); session argv and env
(`launch.ts:52-133`) with Claude's `--settings` and Codex's notify now added by agent-status's
launch hook through `args`; the launch-hook race on close (`service.ts:290-361`); terminal send
semantics and attach replay offsets (`service.ts:414-486`); reconcile on startup and PTY
reconnect (`service.ts:541-554`, `:632-656`); hook-to-status mapping (`hooks.ts`); asks' 60 s
wait cap and persistence (`asks.ts`); the Claude runner (`structured/claude-runner.ts`).

`quirky.session` on activation reconciles its records with `context.pty.list()` (missing marked
`exited`), listens to `onExit`/`onReconnect`, and on `close` of a structured session emits
`removed` (which `quirky.structured` listens to, stopping its runner). `quirky.agent-status`
listens to `hook.received`, maps it with v1's `statusForHook`, calls `quirky.session/setStatus`, and
on `done`/`waiting` calls `context.notify` with the worktree name as title, the v1 body,
`open: { view: 'view:quirky.session/worktree', input: { worktree, session } }` and
`desktop: getSetting('notifications')`. It writes its Claude settings file to
`<dataDir>/claude-settings.json`, with each hook running `<home>/bin/quirky-hook claude`.
`quirky.ask` notifies on create with `open` pointing at nothing (the panel opens itself) and,
when `ui.state` shows no panel open and a window is connected, calls `ui.panel.open` for
`panel:quirky.ask/questions`.

### v1 data import

Back-links: D14, SC-26. Each owning plugin's first store migration is a function that opens
`<context.home>/quirky.db` read-only, if it exists and has the table, and copies:
`quirky.repo` repos; `quirky.session` sessions (with `repo_id`) and the `worktrees` ownership map
(into `quirky.worktree`'s store); `quirky.ask` asks; `quirky.structured` structured_messages;
settings `worktreesRoot` -> `setting:quirky.worktree/worktreesRoot`, `terminalScrollback` ->
`setting:quirky.terminal/scrollback`, `notifications` -> `setting:quirky.agent-status/notifications`
(written through `context.call('setting.set', ...)` on first activation when no value is stored and
the v1 row exists; a scrollback outside 500..10000 is clamped into it first, and a value that is the
wrong type is skipped with a log line). The kernel never drops the v1 tables.

### Layout and windows

Back-links: D21..D23, SC-35..SC-42.

`SCHEMA:`
```
UiLayout = {view: {id: string, input?: unknown} | null, panel: string | null, sidebar: boolean, focus: 'sidebar'|'view'|'panel'|null}
UiWindowInfo = {connId: number, name?: string, focused: boolean}
UiSlotState = {id, kind: 'sidebar-section'|'panel'|'view', plugin, title, shown: boolean, report?: unknown}
UiState = {windows: UiWindowInfo[], layout: UiLayout, slots: UiSlotState[]}
```
- `LayoutService` reads and writes `ui_state` key `layout`; default `{view: null, panel: null, sidebar: true, focus: null}`.
- Reads (`ui.state`, and the window's own) drop a `view` or `panel` that is not effective in the
  current UI model, without rewriting the stored layout until the next change.
- Windows are connections with role `ui`. Reports are kept per `(connId, slot)` and dropped on
  disconnect; `ui.state` shows, per slot, the report from the focused window, else the most recent.
  A report over 64 KiB (JSON length) is InvalidParams and adds a warning to the slot's plugin.
- `ui.command.run`: the command must be in `UiModel.commands`; `args` checked against the
  contribution's `args` schema (absent means `{type: object}` with no properties). Target is the
  window with the latest `focusedAt`, else the latest connected. No window: Conflict
  `no Quirky window is open`. Reply timeout 30 s or target disconnect: Conflict `the window did not
  answer`. A reply `error` becomes Conflict with its message.

### Distro layer

Back-links: D26, D29, SC-54..SC-58.

`SCHEMA:` (`distro.ts`)
```
DistroManifest = {id: string (plugin-ID syntax), name, version, description?, plugins?: string[] (relative dirs),
                  disable?: string[] (plugin or contribution IDs), settings?: Record<settingId, boolean|number|string>,
                  theme?: string (theme contribution ID), keybindings?: Record<chord, commandId>}
DistroInfo = {id, name, version, description?, plugins: string[] (IDs), installedAt: number}
PluginInspection = {id, name, version, description?, contributions: {kind, id, data}[], overrides: {id, replaces: string}[],
                    disables: string[], installed?: {version, added: string[], removed: string[]}}
DistroInspection = {manifest: DistroManifest, plugins: PluginInspection[], settings: {id, current, next}[]}
```
- File `quirky-distro.json` at the distro root. Unknown fields are errors, as for plugin manifests.
- Install validates everything first (manifest; each plugin with `parseManifest(source: 'installed')`;
  no plugin ID already installed outside this distro; settings values against their declarations
  among built-ins and the distro's plugins; theme exists; chords parse) and changes nothing on
  any error. Then copies each plugin directory to `<home>/plugins/.tmp-<id>` and renames into
  place, writes the `distro` row, rescans, and broadcasts `plugin.changed`, `setting.changed` for
  each layered setting and `theme.changed`.
- `distro.remove` deletes the distro's plugin directories and their `plugin-data`, the row, and
  rescans with the same broadcasts.
- Safe mode: the host and UI service ignore the distro row; the row is kept.

### Plugin install

Back-links: D27, D28, SC-49..SC-53. `inspectPlugin(path)` parses the manifest with no code run.
`installPlugin` copies through a dot-prefixed temp directory and renames (replacing an existing
install after deactivating it), then `rescan()`. Nothing in the daemon reads the source path after
install. `uninstallPlugin(id)` refuses a built-in with InvalidParams `built-in plugins can be
disabled but not removed`, refuses a distro's plugin with Conflict naming the distro, else deletes
`<home>/plugins/<id>` and `<home>/plugin-data/<id>` after deactivating, then rescans.

### Safe mode

Back-links: D29, SC-58. `startDaemon({ safeMode: true })`: discovery skips the installed directory
(installed plugins are still listed, state `disabled`, `disabledReason: 'safe-mode'`), the disabled
set is empty, the distro layer is off. Nothing is written to `disabled_ids`, `distro` or
`setting_values` because of safe mode. `quirky daemon restart [--disable-plugins]` calls
`daemon.stop`, waits until `/health` stops answering (10 s), then `ensureDaemon({ args })`.

### CLI behavior

Back-links: SC-1, SC-6, SC-15, SC-16, SC-43, SC-44, D18, D19, D34.

- `--version`/`-v` (optionally with `--json`) as the only other token: print and exit 0 before any
  routing or connection.
- Request IDs: base = `--retry-request` value (at most 64 characters) or a fresh UUID; each call's
  ID is `<base>:<first 12 hex of sha256(method)>#<k>`, `k` counting calls to that method in this
  invocation, so every ID fits the 128-character limit.
- Lost reply (`ConnectionLost`): reconnect and resend with the same ID, at most two more times;
  then exit 1 with `connection lost; rerun with --retry-request <base>`.
- `--yes`: the link adds `yes: true` to calls of destructive methods (kernel ones from
  `KERNEL_METHOD_SCHEMAS`, plugin ones from the catalog's `destructive`).
- ConfirmationRequired: print `confirm in Quirky: <action> (ask <askId>); or rerun with --yes` to
  stderr; loop `quirky.ask/wait {askId, timeoutMs: 60000}` until not pending; `declined` exits 1
  with code `declined`; otherwise repeat the call with `confirmation: askId`.
- JSON error codes: add `confirmation-required` (-32010) and `declined` (Conflict whose message is
  `declined`) to `RPC_ERROR_CODES` in `main.ts:130`.
- Text formats: each ported command keeps its v1 formatter output byte for byte.

### Sample distro

Back-links: D30, SC-59. `distros/sample/quirky-distro.json`: `{ id: "sample", name: "Sample",
version: "1.0.0", plugins: ["sample.sidebar"], disable: ["quirky.git"] }`. `sample.sidebar`
overrides `sidebar-section:quirky.worktree/worktrees` (title "Worktrees (flat)") with a UI module
(plain ES module, no build) that lists every worktree in one list from `quirky.worktree/list` and
reports `{ flat: true, worktrees: [{id, name}] }`; clicking one opens the session view.

## Data models

`SCHEMA:` (kernel `quirky.db`, new tables)
```
request_log(request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, outcome TEXT NOT NULL /* JSON {result}|{error:{code,message,data?}} */, created_at INTEGER NOT NULL)
confirmations(ask_id TEXT PRIMARY KEY, method TEXT NOT NULL, digest TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)
distro(id TEXT PRIMARY KEY, manifest TEXT NOT NULL, plugins TEXT NOT NULL /* JSON string[] */, installed_at INTEGER NOT NULL)
```
`request_log` and `confirmations` rows older than 24 hours are deleted at startup and hourly
(unref'd timer).

`SCHEMA:` (plugin stores, `<home>/plugin-data/<id>/store.db`) — the v1 columns of `store.ts`:
`quirky.repo` `repos`; `quirky.worktree` `worktrees(id, repo_id)`; `quirky.session`
`sessions(..., repo_id)`; `quirky.ask` `asks`; `quirky.structured` `structured_messages`.

## DO-NOT-CHANGE fences

- `packages/pty-host/src` protocol and history behavior, except the socket path: the PTY host must
  stay adoptable by a new daemon (architecture.md "Processes").
- The `quirky ask` JSON lines (`{"status":"registered","askId":...}`, then one envelope line) and
  exit 0 for registered outcomes: agent skills written for `orca ask` depend on them (v1.md "CLI").
- `packages/daemon/src/plugins/registry.ts` override precedence (`beats`, :256-281) and the
  m0-ui-api keybinding precedence other than the distro tier: earlier items' decisions bind them.
- The schema subset in `schema.ts` (`checkSchemaDeclaration`, `validateValue`): m0-scripting D4 is hard to reverse.
- `docs/loop/LOOP.md`, `scripts/build-loop/`: protected loop paths.
- Hook script contract (`QUIRKY_HOOK_SCRIPT`, `launch.ts:144`): running agents outside this build call it.

## Always / Ask / Never

**Always**
- Every test that starts a process uses a fresh temp `QUIRKY_HOME` (keep it short, under `/tmp`, so sockets fit) and kills what it started.
- Built-in plugins reach the kernel only through `context`; SC-24's import scan enforces it.
- New kernel methods get a schema entry, a handler and a `Methods` entry together (the compiler checks all three).
- Declare `readOnly: true` on every plugin method that changes nothing.

**Ask** (record a decision in `docs/loop/decisions/m0-core.md` instead of asking)
- Any change to a scenario's observable behavior: amend `logic.md` first.
- A v1 test whose expectation can't hold under the port beyond the listed renames.

**Never**
- Never import `packages/daemon` from `plugins/`.
- Never broadcast `hook.received` to clients.
- Never run plugin code to inspect it.
- Never edit the user's `~/.quirky`, `~/.claude` or `~/.codex` from tests.

## Cross-cutting

- **Security:** socket 0600 under a 0700 directory, token required in hello; the short-path
  directory is checked for owner and mode; hook token unchanged; confirmations bind method and
  params and are single-use; plugin copies refuse symlinks that point outside the source directory.
- **Migration:** v1 data import (above); protocol 2 makes an old window or CLI fail at hello.
- **Observability:** daemon log lines for socket listen path, safe mode, distro install/remove,
  plugin install/uninstall, request-log prune counts.
- **Rollback:** removing the distro or uninstalling a plugin is the rollback for those; v1 tables
  stay readable.
- **Platform (`deferred: platform`):** unix socket (Windows needs a named pipe), `/tmp/quirky-<uid>`
  short directory, osascript notifier, `open -a Quirky`.

## Test seams

- `startHarness` (`packages/daemon/test/helpers.ts:28`) keeps a fake PTY host and gains
  `builtinPluginsDir` defaulting to the repo `plugins/`. Plugin-level fakes go through the
  environment: `QUIRKY_TEST_FAKE_GIT=<module path>` (read by `quirky.git` and `quirky.worktree` to
  import a `GitApi`-shaped module; `packages/daemon/test/fixtures/fake-git.ts` moves to a shared
  `plugins/test-support/` workspace package), `QUIRKY_TEST_STRUCTURED_RUNNER=<module path>` (read by
  `quirky.structured`), `QUIRKY_TEST_ENTER_DELAY_MS` (read by `quirky.terminal`). These are read only
  when set; production never sets them.
- The fake CLI daemon (`packages/cli/test/fixtures/fake-daemon.ts`) gains a socket listener and
  writes `socket` into `runtime.json`; its v1 method switch moves to the new names.
- Headless window: `packages/ui/test/fixtures/headless-window.ts` registers happy-dom, renders the
  real `App` against a harness daemon with role `ui`, and maps plugin module URLs
  `/plugins/<id>/dist/ui.js` to `plugins/<id>/src/ui.tsx` (and `sample.sidebar`'s plain module to
  its file). xterm's WebGL addon is allowed to fail there.

## Testing strategy

| Area | Test files | Covers |
|---|---|---|
| Protocol | `packages/protocol/test/{kernel-schemas,socket-path,distro,client}.test.ts` | new schemas and counts, path rule, distro manifest parse, socket client and `ConnectionLost` |
| Transport | `packages/daemon/test/socket.test.ts` | SC-1..SC-5 |
| Dispatch | `packages/daemon/test/plugins/{requests,confirm}.test.ts` | SC-11..SC-14, SC-43..SC-48 at the API |
| Context | `packages/daemon/test/plugins/context-growth.test.ts` | pty, notify, launch, streams, `hook.received` not broadcast |
| Layout | `packages/daemon/test/plugins/layout.test.ts` | SC-35..SC-42 with a scripted `ui` client |
| Install, distros, safe mode | `packages/daemon/test/plugins/{install,distros,safe-mode}.test.ts` | SC-49..SC-58 |
| Each built-in | `plugins/<id>/test/*.test.ts` against `startHarness` | SC-17..SC-34, ported from `repos`, `worktree-lifecycle`, `sessions`, `terminal`, `hooks`, `asks`, `structured`, `structured/claude-runner`, `git/git`, `repo-ownership`, `shell-path` tests |
| Import fence | `plugins/test/imports.test.ts` | SC-24 |
| v1 import | `plugins/test/v1-import.test.ts` | SC-26 |
| CLI | `packages/cli/test/{socket,version,selectors,request-ids,confirm,plugin-commands,ui,distro}.test.ts`, updated `cli.e2e`, `command-spec`, `generated`, `api`, `skill` tests | SC-1, SC-6..SC-10, SC-15, SC-16, SC-20, SC-21, SC-28, SC-43..SC-46 through `runCli` against `startHarness` |
| Window | `packages/ui/test/{layout-shell,routed-commands,reports}.test.ts` with the headless window | SC-36, SC-37, SC-40, SC-41, SC-47 |
| Exit test | `packages/ui/test/exit.e2e.test.ts` (headless window plus `runCli` only for the agent's steps) | SC-59, SC-29's panel report, SC-31, SC-35 |
| Desktop | `apps/desktop/test/events.test.ts` | badge on the new names |

Acceptance bar: every SC has a named test (`test('SC-n: ...')`), and `bun run test`,
`bun test scripts` (except the D31 queue-state test) and `bun run typecheck` pass.

## Non-goals

Everything in the logic spec's [Scope & non-goals](logic.md#scope--non-goals). Also: no change to
the PTY host protocol, no plugin signing, no download sources for plugins or distros, no CSS
isolation for plugin UI (built-ins keep using the shell's `styles.css` classes).
