# Browser agent automation and cookie import — technical specification

Status: **Blocked before implementation**; the selected helper-target model requires resolution under the headless feasibility gate. Logic: [logic.md](logic.md). Complexity tier: crosses plugin/CLI/process/packaging boundaries and creates more than three files. Actual Codex promote/refute review completed with amendments required; failure/import request contracts remain unapproved (decisions D14–D17). This document is not an executable implementation contract.

## Architecture
Trace: [conceptual model](logic.md#conceptual-model), [key decisions](logic.md#key-decisions--rationale).

Create the built-in `plugins/quirky.browser` workspace. Runtime is Bun; npm dependencies `agent-browser` exactly 0.27.0 and `tldts` exactly 7.4.16. The plugin uses only `@quirky/protocol` public types and `PluginContext` plus ordinary trusted Bun/Node filesystem/process/network APIs. No Electron or private daemon/worktree module imports. Chrome is discovered from a configured executable or standard macOS installation, not bundled. Missing executable returns an actionable error, not a mock browser. The helper package's native platform binary contains its daemon runtime and must ship in the desktop distribution; no runtime path may depend on the upstream checkout.

One component implements the full vertical feature (automation, profile/import coordination, schema API/CLI, tests and packaging). This avoids speculative interfaces between cookie policy, Chrome lifecycle, per-profile mutation locking and API targeting. Its internal modules retain separate responsibilities below. A single component/single wave has no non-final checkpoint; final three-lens review covers the whole branch. Read-only source surveys are separate from implementation ownership.

## Code references
Trace: [scope](logic.md#scope--non-goals).

Existing anchors (paths relative to `/Users/zpyoung/orca/workspaces/quirky/build-lane-5`):
- `packages/protocol/src/plugins.ts:49-80`: `PluginContext`; `PluginModule`, `MethodHandler` and `JobHandler` later in the same file define public implementation/lifecycle contracts. `CliContext` is publicly defined in `packages/protocol/src/cli.ts:5-29`.
- `packages/daemon/src/plugins/dispatch.ts:58-148`: schema validation and destructive confirmation; use, do not bypass.
- `packages/daemon/src/plugins/scheduler.ts:201-373`: recurring jobs, deliberately not the explicit import-work store.
- `packages/cli/src/plugin-commands.ts:51-138`: public custom CLI context and declared command loading. CLI supplies cwd explicitly.
- `plugins/quirky.worktree/selector.ts:8-66`: selector behavior reference only; call public `quirky.worktree/list` to resolve IDs/names/paths/cwd. Do not import the selector.
- `plugins/quirky.worktree/quirky-plugin.json:18-137`: list schema and Worktree fields; `plugins/quirky.worktree/test/cli.test.ts:1-30` and `plugins/quirky.repo/test/harness.ts`: real plugin dispatcher harness.
- `scripts/test-support/process-scope.ts:20-66,441-523`: disposable homes/process groups and cleanup; all spawned integration processes must use it.
- `apps/desktop/scripts/bundle-plugins.ts:15-28,48-72`: plugin bundling; generic dependency asset handling may grow for native helper assets, never a browser-specific kernel service.
- `package.json:5-15`: plugin workspace discovery/build/full remote tests/typecheck.

Read-only upstream sources under `/Users/zpyoung/PycharmProjects/orca`:
- `src/main/orcad/external-chromium-browser-session.ts`: `ExternalChromiumBrowserSession.run`, output envelope, capture cleanup, command bounds.
- `src/main/orcad/external-chromium-command-arguments.ts`: `externalChromiumCommandArguments`, `normalizeExternalChromiumCommandResult`, quoted exec parser. Fix first-pattern-only interception and empty-argument parsing; do not copy those defects.
- `src/main/orcad/external-chromium-tab-projection.ts`: `externalChromiumSnapshotResult` and public page projection.
- `src/main/browser/browser-cookie-{validation,import-policy,source-partition,import-write,decryption,safari-parser}.ts`: parser/PSL/partition/write planning; adapt neutral algorithms, not Electron Session interfaces.
- `src/main/browser/chromium-cookie-snapshot.ts`, `browser-cookie-{detection,detection-types,key,firefox-import,safari-import}.ts`: source format/process/permission references.
- `LICENSE`: preserve Lovecast Inc. MIT copyright/permission notice for adapted substantial code.

Create/own these paths (additional focused files inside the named plugin directories are permitted; no sibling plugin edits):
- `plugins/quirky.browser/package.json`, `quirky-plugin.json`, `main.ts`, `cli.ts`, `README.md`, `LICENSE.orca`.
- `plugins/quirky.browser/src/runtime/**`: Chrome discovery/launch/CDP/helper, per-page FIFO and cancellation, command translation, metadata.
- `plugins/quirky.browser/src/profiles/**`: persisted profile/page metadata and profile lifecycle.
- `plugins/quirky.browser/src/cookies/**`: neutral cookie model/validation/partition/domain policy, source snapshots/parsers/macOS key provider, import planner/rollback.
- `plugins/quirky.browser/test/**`: API/CLI acceptance, real Chrome fixtures and synthetic importer fixture tests.
- `apps/desktop/scripts/bundle-plugins.ts` and its existing/new targeted packaging tests only if needed for helper assets; plugin dependency metadata plus root `bun.lock` for package resolution.
- `scripts/test-on-macos.txt`: route exact macOS-dependent browser acceptance test paths to this Mac with an evidenced macOS reason, following the list's rule. This is execution routing, not a skip or suite exclusion; platform-neutral cookie fixtures still run through the ordinary remote route.

## Contracts & interfaces
Trace: [data flow](logic.md#data-flow), [SC-01–18](logic.md#behavior--scenarios).

All methods are schema-declared under `quirky.browser/<name>`. No successful no-ops or unsupported placeholders. API names mirror source method names without `browser` prefix: `tabList`, `tabShow`, `tabCurrent`, `tabCreate`, `tabSwitch`, `tabClose`, `snapshot`, `screenshot`, `fullScreenshot`, `pdf`, `goto`, `back`, `forward`, `reload`, `click`, `dblclick`, `fill`, `type`, `keyboardInsertText`, `keypress`, `select`, `check`, `uncheck`, `focus`, `hover`, `scrollIntoView`, `clear`, `selectAll`, `drag`, `upload`, `scroll`, `wait`, `eval`, `get`, `is`, `find`, `mouseMove`, `mouseDown`, `mouseUp`, `mouseWheel`, `highlight`, `download`, `console`, `network`, `captureStart`, `captureStop`, `interceptEnable`, `interceptDisable`, `interceptList`, `cookieGet`, `cookieSet`, `cookieDelete`, `storageLocalGet`, `storageLocalSet`, `storageLocalClear`, `storageSessionGet`, `storageSessionSet`, `storageSessionClear`, `viewport`, `geolocation`, `setDevice`, `setOffline`, `setHeaders`, `setCredentials`, `setMedia`, `clipboardRead`, `clipboardWrite`, `dialogAccept`, `dialogDismiss`, `profileList`, `profileCreate`, `profileDelete`, `profileShow`, `profileSet`, `profileUseDefault`, `profileClone`, `detectBrowsers`, `importCookies`, `importStart`, `importGet`, `importList`, `identityGet`, `identitySet`, `openUrl`, `exec`.

CLI words are source words grouped under `browser`: `tab list/show/current/create/switch/close`, `tab profile list/create/delete/show/set/use-default/clone`, core action words, `cookie get/set/delete`, `storage local/session get/set/clear`, `mouse move/down/up/wheel`, `capture start/stop`, `intercept enable/disable/list`, `set device/offline/headers/credentials/media`, `clipboard read/write`, `dialog accept/dismiss`, `identity get/set`, `import detect/start/get/list` and `import file/browser` as convenient synchronous import entrypoints. Each command maps to its declared method with exactly declared flags; common `--page`, `--worktree` and `--json` follow CLI conventions. Do not add root-level aliases that collide with existing commands.

Common target params: `page?: string`, `worktree?: string`, `cwd?: string`; tabCreate adds `url?: string, profile?: string`. Profile methods use `profile?: string, name?: string, source?: string` where applicable; require names/source IDs for create/clone. Worktree `all` is read-only filtering; mutations resolve a concrete page or error. Invalid explicit IDs never fall back. Read methods may select the sole/global active managed page when no scope exists; input-mutating commands must not. Cwd resolution uses canonical path containment with a path-separator boundary and chooses the longest worktree root.

A profile launch is single-flight; all targets share that profile's Chrome process but have separate helper sessions. Use `--headless=new`, a private user-data-dir, remote debugging bound only to loopback and an ephemeral endpoint; do not weaken Chrome sandbox/TLS security. Every helper invocation carries explicit `--cdp` targeting and private session/socket/temp directories. Clear inherited AGENT_BROWSER target/profile/args variables so caller environment cannot retarget. Never pass cookie values through a shell. Daemon shutdown/deactivate closes helper sessions and Chrome within the existing 10-second host deactivation bound; cancellation is not blocked behind a running page FIFO.

Direct CDP operations use owned browser/target session IDs only. Cookie scope is profile-wide; input/capture scope is page-only. Never forward endpoint addresses or absolute credential paths in public page metadata. Browser errors use machine-readable browser-specific `code`/`kind` in the result/error structure while preserving public RPC error conventions; schema failures remain invalid params. Distinguish no tab/not found/stale ref/closed/changed/timeout/eval/general errors. Chrome load errors retain requested URL and a loadError field. Do not suppress real network errors.

Ref mapping is generation-aware: navigation, profile switch/tab switch/page close invalidate previous refs, including when helper internally reuses e1. Raw selectors can be accepted where source commands allow them; refs must be validated against the current page snapshot generation before invoking the helper. Exec must reject target/session/profile/launch override flags and tab/browser/session lifecycle commands, not merely strip a flag and then forward a retargeting command. Shell command interpolation is prohibited.

Default command timeout 90s, navigation at most 30s, reload at most 10s, helper close at most 5s; condition wait timeout = requested timeout plus bounded transport overhead. Bound captured output to 50 MiB and terminate children on overflow/timeouts/cancel. Fill/eval use stdin for large values; typing chunks must retain Unicode scalar boundaries and ordering. `selectAll` uses platform-correct selection. Captures read only owned generated output files and delete them in finally; user-directed download paths remain files owned by the request.

### Import contract
Trace: [SC-12–17](logic.md#sc-12-explicit-detection-and-source-selection).

`importCookies` waits for an explicit import; `importStart` returns an ID; `importGet`/`importList` expose queued/running/succeeded/failed state and summary/error. No recurring detection/keychain lookup. Job work is tracked for cancellation on deactivate. All destructive entrypoints share the dispatcher's confirmation rule; a synchronous method must not call its destructive underlying method as a trusted plugin to bypass refusal.

Input is destination profile plus exactly one source: JSON file path or supported browser family/profile. Source roots are runtime defaults under the real home only for explicit real requests. Synthetic tests construct controlled roots and key providers through the importer constructor, not general production environment backdoors to real-home selection. Source names must reject empty/dot/dotdot/slash/backslash/NUL path segments.

Use consistent SQLite backup/snapshot including committed WAL rows; copied files opened through `bun:sqlite` read-only, never modify original DBs. Parse BigInt timestamps safely. Only request Keychain for nonempty supported encrypted Chromium values, via absolute macOS security binary/argument array and bounded timeout; no key logging. Supported macOS AES-CBC uses PBKDF2-HMAC-SHA1 saltysalt/1003/16-byte key and 16-space IV; validate/remove the database-v24 host hash rather than blindly trimming valid plaintext. Unsupported/app-bound encryption yields warning counts, not a false successful decrypt. Preserve faithful Chromium partition identity; Firefox incomplete partition data suppresses the family; Safari unpartitioned rows use source epoch/flags.

Plan before mutation using `tldts` private domains. Normalize/reject unsafe/public suffix domains; disclose/skip google.com and source-bound exclusions; suppress the entire registrable family for unreadable partition data, and refuse import if that family cannot be determined. Domain replacement includes source imported roots, appropriate parent-domain cookies and subdomains without crossing sibling private-suffix tenants. Preserve host-only distinctions. Lock all cookie mutations/imports/profile clone at the profile boundary. Snapshot exact existing CDP identities in the planned scope, remove/write, and on failure remove attempted writes and restore snapshot; if rollback itself fails, report a distinct unsafe-replace failure and no success claim. Import never injects plaintext into a live Chrome DB. Disclose restart-fallback-unavailable if a rejected live write could only have used upstream cold replay; do not claim pending replay exists without implementing it safely. Cleanup snapshots/keys/plaintext files on every path.

## Data models / schemas
Trace: [SC-02/03/11/13](logic.md#behavior--scenarios).

SCHEMA:
- Profile `{id:string, label:string, scope:'default'|'isolated'|'imported', source:null|{browserFamily:string,profileName?:string,importedAt:number}}`; Default id `default`. Persisted paths derive from validated IDs beneath dataDir, not caller strings.
- Page `{browserPageId:string, worktreeId:string|null, profileId:string, index:number, active:boolean, url:string, title:string, loadError:null|{code:string,description:string,validatedUrl:string}}`. No native/CDP identifiers in public projection.
- Snapshot `{browserPageId:string,url:string,title:string,snapshot:string,refs:Array<{ref:string,role:string,name:string}>}`.
- Capture `{data:string,format:'png'|'jpeg'}` for screenshots, `{data:string}` for PDF; base64 data must be the actual file content.
- Neutral cookie `{name:string,value:string,domain:string,path:string,secure:boolean,httpOnly:boolean,sameSite?:'Strict'|'Lax'|'None',expires?:number,hostOnly:boolean,partitionKey?:{topLevelSite:string,hasCrossSiteAncestor:boolean}}`.
- Import summary `{totalCookies:number,importedCookies:number,skippedCookies:number,googleCookiesSkipped?:number,partitionSkippedCookies?:number,domains:string[],warning?:{code:string,reasons?:string[]}}`; failed import returns error, not a successful summary with fabricated imported count.
- Import job `{id:string,profileId:string,status:'queued'|'running'|'succeeded'|'failed',createdAt:number,finishedAt?:number,result?:ImportSummary,error?:{code:string,message:string}}`.

Request schemas must enumerate command-specific fields from external browser.md:208-249 and reject wrong types. Result schemas must represent the actual response. No unconstrained universal forwarding endpoint replaces individual methods. CLI for arrays/objects uses existing JSON/repeatable flag conventions; large expression/value input supports file/stdin handling through the existing public CLI context where necessary.

## DO-NOT-CHANGE fences
Trace: [scope](logic.md#scope--non-goals).
- `docs/loop/LOOP.md`, `scripts/build-loop/**`, `docs/loop/queue.json`, `docs/loop/DECISIONS.md`: orchestration-owned protected paths.
- `/Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/**` and `/Users/zpyoung/PycharmProjects/orca/**`: read-only requirements/reference trees, never implementation destinations.
- Existing plugin/kernel UI/PTY/session behavior: no browser feature code in core, no unrelated refactors, no inherited `.serena` mutation, no Electron import or bundled Chrome.
- Real `~/.quirky`, browser profile roots, Keychain, `~/.claude` and `~/.codex`: tests and smoke never read/write protected real state. Real users' explicit imports are the only source-browser access path.

## Always / Ask / Never
Trace: [decisions locked](logic.md#decisions-locked).
Always use private per-home process ownership, actual API/CLI acceptance, fresh disposable homes, source attribution and bounded cleanup. Always record autonomous decisions.
Ask means record recommended choice under LOOP.md; a locked-decision conflict blocks the item rather than overriding it.
Never use fake fallbacks, mocks as proof of real Chrome behavior, test exclusions/skips to hide missing dependencies, automatic user-state discovery, helper auto-launch after CDP loss, implicit mutating retries or successful no-op method stubs.

## Cross-cutting
Trace: [data flow](logic.md#data-flow), [SC-10/17/18](logic.md#behavior--scenarios).
Public plugin-private dataDir mode 0700 contains profiles, metadata and private helper sockets/output. Keep keys in memory only for the import. Existing daemon auth protects RPC; CDP stays private loopback, inherited target env is removed, process ownership is checked rather than killing arbitrary PIDs. Log bounded operational errors without cookie values/keys, and treat page content as untrusted input. Persist metadata atomically; do not reuse refs/session IDs across daemon lifetimes. Plugin removal never touches source browser data.

Rollback is cookie-snapshot restore for in-flight replacement and source-control rollback for deployment. No schema migration of another plugin. Profile storage may contain browser-managed credentials and is intentionally durable until explicit delete/clear. Other-platform executable discovery, keychain/DPAPI/keyring and process ownership verification are explicitly deferred platform decisions, not claimed portable behavior.

## Testing strategy
Trace: [behavior](logic.md#behavior--scenarios), [source defects](logic.md#source-defect-regressions).

The orchestrator must observe a pre-implementation red API test showing absence of `quirky.browser/tabCreate` (not an import/syntax failure). Workers skip builds/tests/formatters while editing; orchestrator runs all checks after return. Every SC and DF maps by ID to plugin-local daemon API/CLI tests. Real Chrome tests use a local fixture HTTP server and installed Chrome discovered by runtime; no public network or real Keychain. Synthetic source tests generate JSON/SQLite/WAL/encrypted/Safari fixtures and deterministic imported-policy/rollback faults; the acceptance layer invokes real daemon plugin methods with a controlled importer provider, not mocked handler echoes. Parser/policy edge tests may be isolated unit tests as additional evidence, not replacements for API acceptance.

COMMAND:
- `bun test plugins/quirky.browser/test/automation.test.ts` — a single targeted real-browser acceptance file locally; use the complete runner below for the whole test suite and any other acceptance files.
- `bun run build` — packaged plugin/helper assets built, exit 0.
- `bun run test` — required complete remote suite only through this runner, exit 0.
- `bun test scripts` — loop/process support checks, exit 0.
- `bun run typecheck` — all TS contracts, exit 0.

Smoke: launch actual daemon with a new scoped QUIRKY_HOME, register a throwaway Git repo/worktree, use the real quirky CLI to create/navigate/snapshot/fill/capture/profile-switch/import a synthetic cookie file/read cookie/close; inspect exact page/cookie/capture results and verify daemon shutdown leaves no owned process. Remove throwaway scripts/homes after proof. No new UI scenarios: skip web dogfood/native handoff rather than claiming UI coverage.

## Non-goals
Trace: [scope](logic.md#scope--non-goals). No browser UI/screencast presentation/design-mode implementation, remote SSH routing, native chat/artifacts, general plugin process manager, localStorage import, default-profile attachment or bundled Chromium.
