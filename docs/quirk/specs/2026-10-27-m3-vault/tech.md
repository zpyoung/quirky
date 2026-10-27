# AI vault implementation contracts

Status: Reviewed; confirmed Codex F3/F4 corrected before implementation. Logic: [logic.md](logic.md). Complexity gate: crosses plugin/runtime/UI boundaries and more than three source files.

Reader: implementers and reviewers — Decision: where to implement each required behavior and which contracts cannot drift.

## Architecture

Implements [logic conceptual model](logic.md#conceptual-model) and [data flow](logic.md#data-flow).

Create built-in `plugins/quirky.vault`. The daemon plugin owns manifest registration, settings/view-state persistence, scope resolution, worker request routing and public action orchestration. A lazy Bun Worker owns discovery, parsing, parse cache and the separate opt-in FTS database. Renderer and CLI use only public API. Agent launch remains owned by `quirky.session` and provider planning by `quirky.agents`.

Reuse/adapt Orca's MIT parser and query algorithms, not its runtime, Electron, WSL adapters or child-service plumbing. Retain Lovecast's MIT notice in substantial adapted source and fixtures. Use `bun:sqlite`; never import `node:sqlite` into the production closure. Bun 1.4.0 FTS5 creation/insertion/query was exercised locally; richer FTS contracts still need tests.

New file ownership:

- `plugins/quirky.vault/quirky-plugin.json`, `plugins/quirky.vault/main.ts`, `plugins/quirky.vault/cli.ts`: new declared contributions and daemon/CLI activation.
- `plugins/quirky.vault/src/types.ts`: shared JSON contracts only; no runtime imports.
- `plugins/quirky.vault/src/scanner/**`: roots, discovery, source identity/sidecar signatures, bounded record readers, 25 parser routes, parse cache, previews, subagents, deletion validation.
- `plugins/quirky.vault/src/search/**`: SQLite schema/lifecycle, normalized writes, reconciliation, query planning/retrieval/ranking/repair/snippets/cursors/status.
- `plugins/quirky.vault/src/worker.ts`, `worker-client.ts`: message protocol, lazy lifecycle, cancellation/coalescing and graceful shutdown.
- `plugins/quirky.vault/src/service.ts`, `actions.ts`, `view-state.ts`: API implementations using public plugin methods.
- `plugins/quirky.vault/src/window/**`, `plugins/quirky.vault/src/ui.tsx`: new panel, settings view, filtering/virtualization, actions/keyboard/drag, daemon state/reporting. The UI build discovers src/ui.tsx through packages/ui/build.ts:37-52.
- `plugins/quirky.vault/test/**`: isolated real-daemon/API/CLI acceptance tests and source-format fixtures.

## Code references

Implements [logic session actions and scripting](logic.md#session-actions-and-scripting).

Existing anchors are relative to repository root; Orca anchors below are absolute external read-only references.

- `packages/protocol/src/plugins.ts:49-80`: `PluginContext` supplies dataDir/openStore/getSetting/call/provide/emit/subscribe/launch/pty; no private daemon imports are needed.
- `packages/protocol/src/plugins.ts:195-205`: `PluginCaller` contains client role/cwd/worktreeId/sessionId or plugin identity. Do not invent a desktop-versus-web trust boundary absent from this contract.
- `packages/protocol/src/ui.ts:195-242`: mount/provide/call/executeCommand/togglePanel/getLayout/onLayout/confirm/report interfaces.
- `plugins/quirky.session/src/sessions.ts:174-223`: `Sessions.create(params, caller)` establishes cwd/worktree and normal terminal lifecycle. Lines 229-275 implement record-backed `resume`; this is not an external-history resume API.
- `plugins/quirky.agents/src/service.ts:285-297` and its manifest `prepareResume`: planner takes agent/cwd/record/providerSession/fork/hookArgs/hookEnv and returns command/env/record. Reuse it rather than assembling vault-specific command strings.
- `plugins/quirky.worktree/selector.ts:1-66` and manifest list schema: resolve current/explicit worktree using public methods. `quirky.repo/list` and worktree list supply project/path scope.
- `plugins/quirky.terminal/src/open-external.ts:1-45`: public `openExternal({target,reveal?})` validates and opens/reveals an absolute path; `QUIRKY_TEST_OPEN_LOG` is its isolated integration seam.
- `plugins/quirky.terminal/src/window/workspace/GroupView.tsx:1-292` and `controller.ts:550-1107`: terminal-specific drag/tab placement; any cross-plugin drop addition must use public command/API dispatch.
- `packages/ui/src/components/SettingsDialog.tsx:1-139`, `packages/ui/src/plugins/settingsGroups.ts:1-74`: current declarative settings dialog. Vault status/clear/open controls need a public contribution surface, not a vault ID hard-coded into the shell.
- `apps/desktop/scripts/bundle-plugins.ts:15-28,48-72`: bundles main/cli and copies ui/sounds; currently no worker runtime assets. Extend this public packaging contract rather than relying on source paths.
- `plugins/quirky.terminal/test/e2e-ui/features-support.ts`, `support.ts`; `packages/daemon/test/plugins/ui-api.test.ts`: established temporary-home real-daemon/window harnesses.
- `/Users/zpyoung/PycharmProjects/orca/src/main/ai-vault/session-scanner-agent-parser.ts`: authoritative 25-parser dispatch; `session-scanner-agent-sources.ts` and dedicated source modules define roots/layout pruning.
- `/Users/zpyoung/PycharmProjects/orca/src/main/ai-vault/session-scanner-accumulator.ts`, `session-transcript-message-content.ts`, `session-scanner-text-normalization.ts`: folding/title/preview/content extraction algorithms; remove Orca host/resume/native-chat coupling.
- `/Users/zpyoung/PycharmProjects/orca/src/main/ai-vault/session-scanner-every-agent-fixture.ts`, `session-scanner-test-fixtures.ts`, `session-scanner-opencode-sqlite-fixture.ts`: real-format fixture models; adapt Vitest/Node-specific infrastructure to Bun.
- `/Users/zpyoung/PycharmProjects/orca/src/main/ai-vault-search/session-search-{engine,query-planner,retrieval,typo-repair,row-filter,hit-ranking,snippet,page-cursor}.ts`: reusable query closure.
- `/Users/zpyoung/PycharmProjects/orca/src/main/ai-vault-search/session-search-{schema,message-rows,identifier-split,content-hash,retention-delete}.ts`: schema/row/cap/hash/reclamation semantics; replace scanner/runtime and Node SQLite coupling.

## Contracts and interfaces

Implements [logic browsing](logic.md#browsing-and-presentation), [lifecycle](logic.md#consent-settings-and-index-lifecycle), [search](logic.md#search-semantics-and-paging) and [actions](logic.md#session-actions-and-scripting).

### Scanner boundary

`CONTRACT:` `createScanner(options: {sourceHome: string; dataDir: string; env: Record<string,string|undefined>; progress?: (value: ScanProgress)=>void}): VaultScanner`.

`VaultScanner.discover(signal?): Promise<Discovery>` returns candidates and per-root issues/availability; `parse(candidate, onMessage?, signal?): Promise<VaultSession|null>` sends normalized content to a synchronous sink without retaining every transcript in the daemon. `list(request, signal?): Promise<ListResult>` applies scope before depth and uses disposable parse metadata. `get(id): Promise<VaultSession|null>`, `firstPrompt(id): Promise<string|null>`, `subagents(id): Promise<VaultSession[]>`, `deleteTargets(id): Promise<string[]>` resolve stable IDs to discovered sources and validate ownership; no caller-supplied arbitrary file path is authoritative. `invalidate(id)` fences cached/in-flight results after deletion. `close()` flushes/closes only derived metadata.

Discovery candidates carry agent/filePath/source session identity/codexHome and a sidecar-aware signature; SQLite candidates include DB session identity. A signature change must detect source identity/size/mtime and required sidecars. Reject symlink traversal outside roots. Missing root is not automatically evidence that all its indexed files were deleted. Bounded JSONL record budget 10 MiB, extracted message cap 256 KiB; JSON document parsing must not whole-read unbounded files. Parse text normalization must retain valid surrogate pairs.

Source roots follow the feature table and environment overrides, plus additional provider/account roots obtained through owner APIs. For tests, `QUIRKY_VAULT_SOURCE_HOME` replaces the source user home; environment root overrides are confined to the temporary home. Production default is the user's home; this test seam never changes the real config. Supported agents are the exact 25 IDs in the feature source inventory, not all 45 launchable agents.

### Search boundary

`CONTRACT:` `createSearch(options: {dataDir: string; scanner: VaultScanner; progress?: (status: SearchStatus)=>void}): VaultSearch`.

`apply({enabled,historyDays})` closes prior handles and applies policy serially; off never creates/opens the search DB. `search(request): Promise<SearchResponse>` returns the typed query result; `status(): SearchStatus` is observable without enabling. `reconcile({full?,signal?}): Promise<void>` is single-flight and accounts for work due after deadlines. `clear(): Promise<void>` requires the caller to persist off first and removes DB/WAL/SHM only after closure. `remove(id)` hides the proven deleted session immediately. `close()` stops timers, drains/cancels owned work and closes SQLite.

The Worker owns every search DB/statement. Use one owned connection unless measured requirements justify more. Each normalized source replacement writes session, messages, FTS rows and source status transactionally; abandoned/orphan rows never answer searches. Generation changes on writes/reclamation; incarnation changes on DB rebuild. No SQLite transaction or iterator crosses an await.

Port query planner semantics and FTS escape rules, including tokenizer `unicode61` tokenchars `_.-/+`, role weights 3/2/1/1 and conversation 3/2/0/0, 8,000-character text chunks, 3,072-character tool cap, content-hash fork collapse after at least two of the first eight messages, 600-session candidate cap, 512-character snippets and query cap, 48 body/64 expanded-term caps. Typo repair checks live scoped vocabulary with the feature's similarity/frequency bounds. Snippets prefer user/assistant/tool and safely separate source-authored marker strings from actual highlight marks.

`CONTRACT:` Evidence uses raw `[[` and `]]` only for FTS-verified highlight delimiters. Encode source literal U+E002 as U+E002 followed by `2`, source-authored `[[` as U+E002 followed by `0`, and source-authored `]]` as U+E002 followed by `1`. Escape U+E002 first. The renderer parses raw marks, then decodes each text run once (2 to U+E002, 0 to literal opening brackets, 1 to literal closing brackets), never rescanning decoded text for marks. This keeps arbitrary source text injective and text-only.

Reconcile cadence 20 seconds with bounded passes; full sweep at least every 15 cycles and when work remains owed. Detect append/rewrite/shrink/inode change/sidecars, retention, failed-file holdout and missing/unverifiable roots. Fresh requests wait up to 5 seconds, then mark freshness truncated. A whole reread is permitted where required for correctness, but unchanged source signatures must skip parsing and large files must remain bounded-memory.

### Worker boundary

`SCHEMA:` Requests are `{id:number, op:string, args:object}`; responses `{id:number, result?:unknown, error?:{kind:string,message:string}}`; events `{event:'scanProgress'|'searchStatus', data:object}`. Register message handling before awaited initialization. Operations mirror scanner/search entry points; every request settles once. Cancellation tokens are per caller; equal list requests may coalesce but shared work stops only after all callers cancel. Dispose aborts pending calls and closes handles; no silent action retry after uncertain mutation.

The worker is created by the plugin, inside quirkyd, from a packaged entrypoint. Browse-only idle lifetime is bounded; enabled index keeps its worker available. Worker failure rejects pending work and next read can recreate it; destructive actions are not automatically replayed. Plugin teardown and daemon shutdown must release it.

### Public method and CLI boundary

Declare every method/result schema in `quirky-plugin.json`, including CLI contributions. Exact names under `quirky.vault/`:

- `list`, `cancelList`, `get`, `firstPrompt`, `subagents` for browsing/inspection.
- `search`, `searchStatus`, `setSearchEnabled`, `clearSearchIndex` for index/search control.
- `getView`, `setView`, `resetView` for daemon-owned stable view state and transient query/selection/scope/expanded state.
- `prepareResume`, `resume`, `deleteSession`, `openSource`, `openWorkingDirectory`, `jump`, `handoff` for actions.
- UI command `command:quirky.vault/open` opens `panel:quirky.vault/history`, applies optional agent/session query and focuses search; `command:quirky.vault/settings` opens the settings view.

API method names and CLI group are vault-owned, not Orca `aiVault:*` aliases. CLI has `vault list`, `vault search`, `vault search-status`, `vault enable`, `vault clear`, `vault get`, `vault resume`, `vault delete`, `vault view`, `vault open` plus generated action methods. `vault search --index-status` is supported and rejects all query flags. Query flags mirror logic SC-22. All calls use existing auth; same-token clients have the user's full local privileges. Future remote-host forwarding must not invent desktop-only authentication or bypass shared transport.

`deleteSession` and `clearSearchIndex` use the established public ask/yes pattern for irreversible actions; UI confirms and passes explicit yes only after approval. API false/unavailable outcomes must not be rendered as success. `prepareResume` never launches anything and returns provider-planned command/env; `resume` validates current source/cwd, delegates launch and returns the actual new Session. Handoff/session-info are optional owner integrations discovered from effective contributions, not private imports or simulated replacements. Unavailable owner action reports a reason. Expose open/filter command now so future owner can call it unchanged.

`CONTRACT:` Public result envelopes are canonical, not guessed compatibility variants. get returns HostedSession|null directly; firstPrompt returns `{prompt:string|null}`; subagents returns HostedSession[] directly. getView/setView(flat Partial<ViewState>)/resetView return ViewState directly. searchStatus/setSearchEnabled return `{status:SearchStatus,hosts:HostOutcome[]}`. clearSearchIndex returns `{cleared:boolean,status:SearchStatus,hosts:HostOutcome[],reason?:string}`. resume returns Session directly. openSource accepts `{id,mode:'view'|'open'|'reveal'}` and returns `{ok:true}`. deleteSession returns `{deleted:boolean,trashed:number,alreadyMissing:boolean,reason?:string}`; trashed is a count, not source paths. Schemas and renderer must use these exact envelopes; no wrapper/raw fallbacks.

Every public SearchResponse variant may include a typed hosts outcome list, including unavailable and stale/malformed cursors. Worker-local responses omit that transport metadata; callers must not confuse an honest per-host unavailable result with an untyped extra-field error.

Host input is `local`, `all` or an effective host contribution identity. Local/All without hosts both use local data. Optional `vault-host` contributions declare label and a public method prefix to forward compatible list/search/status/enable actions; validate capability/response schemas. Host failures remain partial failures with identity. Remote results never return local source paths/resume commands/root paths; never resume or delete a remote source locally. Pairing/E2EE/listener implementation is fenced to its roadmap owner.

## Data models and schemas

Implements [logic conceptual model](logic.md#conceptual-model) and [search semantics](logic.md#search-semantics-and-paging).

`SCHEMA:` `VaultMessage = {role:'user'|'assistant'|'tool'|'system'; text:string; timestamp:number|null}`.

`SCHEMA:` `VaultSession = {id:string; agent:string; sessionId:string; title:string; cwd:string|null; branch:string|null; model:string|null; filePath:string; codexHome:string|null; createdAt:number; updatedAt:number; modifiedAt:number; messageCount:number; totalTokens:number|null; previewMessages:VaultMessage[]; firstUserPrompt?:string; lastUserPrompt?:string; queuedMessageCount:number; subagentTranscriptCount:number; subagent?:boolean; presence:'present'|'missing'|'unverifiable'}`. ID deterministically binds agent, canonical source and provider session ID, including SQLite logical identity. Preview metadata is bounded; full first prompt fetched separately.

`SCHEMA:` `ListRequest = {agents?:string[]; scopePaths?:string[]; limit?:number; unlimited?:boolean; force?:boolean; requestToken?:string; sort?:'updated'|'created'; hideEmpty?:boolean}`; `ListResult = {sessions:VaultSession[]; issues:ScanIssue[]; scannedFiles:number; scannedAt:number; hasMore:boolean; total:number}`. Empty agents means no selected agents; omitted means all supported agents. Paths max 64.

`SCHEMA:` Scanner-local `ListRequest`/`ListResult` and `VaultSession` above never cross the host aggregator unwrapped. Public `HostSelector = 'local'|'all'|string`; `PublicListRequest = ListRequest & {host?:HostSelector;within?:{worktree?:string;repo?:string}}`. `HostOutcome = {hostId:string;label:string;kind:'ok'|'unavailable'|'error';reason?:string;scannedFiles:number;scannedAt:number|null}`. `HostedSession = Omit<VaultSession,'id'|'filePath'|'codexHome'> & {id:string;sourceId:string;hostId:string;source:{presence:'present'|'missing'|'unverifiable';filePath?:string;codexHome?:string}}`. Public ID opaquely encodes `{hostId,sourceId}` and round-trips without losing host ownership. Local hostId is local; nonlocal host IDs are effective contribution IDs. `PublicListResult = {sessions:HostedSession[];issues:(ScanIssue & {hostId:string})[];hosts:HostOutcome[];scannedFiles:number;scannedAt:number;hasMore:boolean;total:number}`. Local rows include permitted source paths; remote rows omit filePath/codexHome and all prepared commands. Actions decode IDs and reject local execution for nonlocal rows. Same provider ID/path on two hosts remains distinct. SearchHit also carries hostId/sourceId and host-qualified ID; public search/status summaries use HostOutcome, not unknown JSON. Aggregated cursors bind each host cursor plus host set/request key and invalidate if any participating host reports stale.

`SCHEMA:` `SearchRequest = {query:string; scope?:'conversation'|'all'; freshness?:'indexed'|'wait-until-current'; limit?:number; cursor?:string; filters?:{agents?:string[]; scopePaths?:string[]; since?:string; sort?:'relevance'|'newest'}; within?:{worktree?:string; repo?:string}; debug?:boolean; host?:string}`. `within` and scopePaths are mutually exclusive; limit defaults 20 within 1-100; since requires ISO offset. Query cap/truncation follows source.

`SCHEMA:` `SearchResponse` is `{kind:'results'; hits:SearchHit[]; page:{cursor:string|null; hasMore:boolean}; generation:number; truncated:{candidates:boolean; snippets:boolean; query:boolean; freshness:boolean}; durationMs:number; repairedTerms?:Record<string,string>; hosts?:HostOutcome[]}` or `{kind:'stale-cursor'}` or `{kind:'malformed-cursor'}` or `{kind:'unavailable';reason:'disabled'|'not-ready'|'no-service'|'scope-unknown'|'unsupported-agent'}`. A hit carries session identity/metadata, score, duplicateCount, source presence/path when permitted, evidence `{snippet,role,timestamp}|null` and optional prepared resume command. Rendering never uses raw HTML from a snippet.

`SCHEMA:` `SearchStatus = {enabled:boolean;phase:'closed'|'idle'|'indexing'|'current'|'degraded';filesIndexed:number;filesDue:number;filesFailed:number;messagesIndexed:number;degradedRoots:{root?:string;reason:string}[];lastReconcileAt:number|null;lastSweepCompletedAt:number|null;generation:number;supportedAgents:string[];sessionsByAgent:Record<string,number>}`.

`SCHEMA:` `ViewState` includes disabledAgents, browseSort, searchSort, group(project/folder/agent), hideEmptySessions, sessionLimit(250/500/1000/null); transient host, scope, query, selectedId, expandedIds and focusedSearch. Store stable and transient state separately; only stable fields persist across restarts. The only visible indexing setting is boolean `search-enabled` default false. Retention is nonvisual plugin-store policy `historyDays:number|null`, default null, validated as integer 1-3650 when changed through the policy API; do not declare a numeric setting that the generic Settings dialog would render. `setSearchEnabled` may take optional historyDays and must serialize policy persistence with worker apply.

Internal scanner/search types and runtime entrypoint names may be split into smaller modules, but the shared scanner/search boundary is immutable during the first implementation wave. Any incompatible correction updates this spec and downstream workers before implementation.

## Public API growth

Implements [logic actions](logic.md#session-actions-and-scripting), SC-08/17/20/24.

1. Add `quirky.session/resumeExternal` with schema `{agent:string,cwd:string,providerSession:{id:string,transcriptPath:string|null},worktree?:string,record?:SessionLaunch|null,fork?:boolean}`. Preserve arbitrary existing source cwd independently of destination worktree ownership; never register a repo/folder just to resume. Existing Sessions.create supports a cwd override and SessionRecords stores nullable repo ownership without FK constraints. An omitted destination may use existing floating ownership. Validate cwd/provider ID/catalog resumability and delegate prepareResume plus launch-hook pipeline. Never accept a prebuilt arbitrary shell command. Return actual Session with provider identity; preserve record-backed resume.
   For external history without a recorded Quirky launch, obtain effective command/args/env from public quirky.agents/get and pass that LaunchRecord to prepareResume/resumeExternal; overlay source codexHome as CODEX_HOME when present. Existing buildResumePlan deliberately treats null record as catalog defaults, not current configuration (plugins/quirky.agents/src/core/plan.ts:433-447). Do not change that record-backed behavior or call prepareLaunch just to copy a command, because prepareLaunch writes workspace trust (plugins/quirky.agents/src/service.ts:265-282).
2. Add OS trash action using a vault-owned implementation or narrow public terminal method; never `rm` originals. The vault validates roots/realpath/lstat and only then executes macOS trash with safely passed argv. Tests use isolated paths and exercise actual move semantics or a genuine platform trash adapter; no mocked success.
3. Add generic `settings-section` contribution fields `{id,title,description?,order?}`. It is code-backed, included in the UI module provides, and exposed as `UiModel.settingsSections:UiSlotEntry[]`; SettingsDialog mounts it with standard MountFunction. No vault-specific shell branch. Existing scalar controls and validation stay unchanged.
4. Add manifest `workers:Record<string,string>` mapping a name to a plugin-root-relative source entrypoint; validate no escaping paths. Bundler compiles each declared entry and rewrites its value to the packaged sibling .js path. Public `PluginContext.workerEntrypoint(name):string` resolves only a declared entry to an absolute Worker-compatible file path/URL. Vault creates Worker from the named scanner entry. No import.meta source guess or unbundled fallback.
5. Add terminal-owned public `adoptSession({session:string,group:string})` to place an already-created session through the layout owner's serialized queue; validate group exists and its workspace equals session.worktreeId. Before launching to a group, resolve its owner through the terminal owner so resumeExternal receives matching destination ownership while retaining source cwd. Anchors: plugins/quirky.terminal/src/layout/service.ts:164-218 and :405-450; plugins/quirky.terminal/src/layout/reconcile.ts:38-51; plugins/quirky.session/src/records.ts:111-124 and :182-207. Cross-plugin drop uses generic bounded action descriptor/public command dispatch, never vault renderer imports. Validate explicit target before launch; no renderer-only adoption.

## DO-NOT-CHANGE fences

- `docs/loop/LOOP.md`, `scripts/build-loop/**`, `docs/loop/queue.json`, `docs/loop/DECISIONS.md`: protected queue/protocol; only approved queue commands may change shared state.
- `/Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/orca-features/**` and `/Users/zpyoung/PycharmProjects/orca/**`: reference-only sources; do not modify.
- `docs/architecture.md` process/structured-chat decisions and `BRIEF.md` dropped scope: no helper scanner processes, native interactive chat, SSH/WSL subsystem or second transport.
- `plugins/quirky.agents` provider launch/resume/configuration semantics: reuse planner; no parallel vault shell constructor or compatibility alias. If provider semantics need a confirmed correction, update their existing owner and all callers through a separate explicit scoped fix.
- PTY host/history core: vault must not parse or copy PTY history into transcript search. Agent source files are the source of truth.
- Real `~/.claude`, `~/.codex`, `~/.quirky` and other agent homes: tests never mutate/read production session state; use temporary source and Quirky homes with confined overrides.

## Always / ask / never

Implements [logic decisions locked](logic.md#decisions-locked).

Always: public API only, schema-visible UI actions, disposable derived stores, sensitive-data disclosure, bounded memory/text, independent cancellation, atomic normalized writes, deterministic paging, safe shell argv, honest failure, source validation immediately before actions, cleanup of owned workers/processes.

Ask: no human asks in this unattended lane. Record any reversible implementation choice in the decision log. A true conflict with locked decisions halts the affected work and formally blocks the item.

Never: silently narrow acceptance, fake host/search/resume success, index before consent, widen unknown scope, delete originals outside validated OS-trash targets, parse on daemon main thread, fork a scanner helper, import private daemon/plugin code, replay uncertain mutations, or treat tests alone as packaged/UI proof.

## Cross-cutting

Implements [logic lifecycle](logic.md#consent-settings-and-index-lifecycle) and [defect regressions](logic.md#defects-and-boundary-regressions).

Security: directory permissions inherit 0700 plugin dataDir; derived databases and logs contain private data. No transcript text in daemon diagnostics. SQL/FTS quoting are separate boundaries. Shell commands use existing planner. Remote host results are redacted before return. Deletion checks canonical ownership and symlinks including companions.

Persistence: append-only plugin store migrations for view/tip policy; parse/search caches have independent disposable schema versions. Failed enable/clear policy writes do not leave reported state ahead of persisted policy. Disabling plugin preserves data and stops worker; explicit clear removes only search copy. No existing source migration.

Observability: schema-declared scan/search-status/view events and report summaries expose active filters, counts, issues, selected/expanded identities and focus without dumping transcript bodies. Counts reflect actual source/index work, not expected totals.

Rollback: disable quirky.vault stops its jobs/workers and hides contributions without affecting agent source/session records; search data is retained until explicit clear. Linux/Windows support remains unverified and logged under platform deferral.

## Testing strategy

Implements all [logic acceptance scenarios](logic.md#behavior-and-acceptance-scenarios).

- `plugins/quirky.vault/test/scanner.test.ts` and minimized fixtures: format/title/sidecar/SQLite/pruning/caps; all 25 identities plus mutable-tail/sidecar edge cases.
- `plugins/quirky.vault/test/search.test.ts`: real Bun FTS schema/tokenizer/ranking/column/rowid-subselect contracts, snippet-marker safety, cursor/candidate/fork boundaries; no mocked SQL.
- `plugins/quirky.vault/test/api.test.ts`, `cli.test.ts`, `actions.test.ts`, `lifecycle.test.ts`: real temporary daemon and CLI drive SC-01 through SC-24; tests enumerate scenario coverage in names and assert concrete results/state. Fake agent binaries log actual exec argv/cwd/env. Each process uses fresh QUIRKY_HOME/source home and is stopped in finally/afterEach.
- Public API growth tests remain in their owner's existing test conventions; update existing consumers/contracts when changed. Permanent tests target plausible behavior boundaries, not source wording or forwarding echoes.
- `plugins/quirky.vault/test/window.test.ts` uses existing mounted-window/real API conventions for control state. Actual UI smoke is separate and mandatory: build, temporary daemon, unattended web dogfood for SC-03/05/06/07/08/09/12/15/18/20/21, with tool-caused limitations recorded and native-only banners/Finder/clipboard OS behavior handed off through native scenarios.
- After every implementation wave, orchestrator runs task-scoped checks once; workers skip mid-flight build/lint/test/format commands. Final gates: `bun run build`, `bun run test` (remote whole suite only), `bun test scripts`, `bun run typecheck`; smoke the packaged worker and actual fake-provider resume; merge build/roadmap and read brought-in decision logs before final cross-family review.

## Non-goals

See [logic scope](logic.md#scope-and-non-goals). This spec does not authorize native-chat UI, SSH/WSL or mobile transport infrastructure, private API shortcuts, broad existing-plugin refactors or a second launcher. Source format/query behavior is not optional merely because a port requires adaptation.
