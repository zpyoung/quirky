# Accounts implementation contracts

Status: Combined Codex promote/refute review completed; confirmed findings corrected before implementation. Executor: omp task subagents; OpenAI authors, Gemini final review fallback. [Logic](logic.md).

## Architecture

Implements [conceptual model](logic.md#conceptual-model) and [data flow](logic.md#data-flow). A new built-in `plugins/quirky.accounts` owns all account state, provider adapters, polling, methods, CLI and account UI. There are no runtime imports from Orca or other Quirky packages beyond `@quirky/protocol`. Source ports read `/Users/zpyoung/PycharmProjects/orca` and adapt small provider-specific units to Bun.

Existing public `context.call`, `openStore`, events, jobs and UI mount contracts are sufficient for daemon behavior. Add a generic `status-bar` UI slot and a generic optional `shellInit` file input to public launch environment assembly. Session and structured built-in plugins discover the effective `method:quirky.accounts/prepare` contribution and call it before starting the agent; absence/disable means unmanaged launch. A method present but failing is fatal; do not catch it as optional. This is a required cross-plugin operation, not a hook, and creates no manifest dependency cycle.

Add the public `terminal-accessory` contribution consumed by `quirky.terminal`: declaration `{id,title,order?,view}` names a public view contribution. PaneLayer mounts effective declarations in order/ID using `context.mountView(view, element, {sessionId,paneId})`, with a host-owned root per accessory. The terminal plugin validates declarations and view availability, refreshes on plugin changes, unmounts on session/pane removal or override/disable, and includes mounted accessory IDs in its readable workspace report. Accounts declares `terminal-accessory:quirky.accounts/account-switch` pointing to `view:quirky.accounts/session-accessory`. Accounts' daemon-owned stale-session/UI state reports all visible account labels and actions; no private terminal DOM access or unreported UI-only state.

## Code references

Implements [scope](logic.md#scope-and-non-goals) and [AC10](logic.md#ac10-next-launch-routing-and-safety).

- `/Users/zpyoung/orca/workspaces/quirky/build-lane-10/packages/protocol/src/plugins.ts`: `PluginContext.call/openStore`, `PluginLaunch.env` and launch types. Add `shellInit?: string` to env input, retaining existing reserved-env rules.
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-10/packages/protocol/src/ui.ts`: `UI_KINDS`, `CODE_BACKED_KINDS`, `UiSlotEntry`, `UiSlotState`, `UiModel`. Add `status-bar`, `statusBars`, propagate every model consumer and fixture.
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-10/packages/daemon/src/plugins/ui-kinds.ts`, `ui-model.ts`: validate and resolve ordered public status-bar slots, stable override/disable semantics.
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-10/packages/ui/src/plugins/host.ts`, `PluginSlot.tsx`, `App.tsx`, `styles.css`: mount/report the status bar using existing plugin ownership/lazy-loading pattern. No account-specific kernel UI.
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-10/packages/daemon/src/launch.ts`: `buildSessionEnv`, interactive bash/zsh wrappers (`bashRcfile`, zsh startup generator). Kernel-owned env points to optional trusted plugin shell init sourced after user rc and before first prompt.
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-10/plugins/quirky.session/src/sessions.ts`: `SessionService.start` pre-spawn common boundary and resume path; account patch must reach planning and final environment without mutating recorded user launch env. Required prep errors remove starting record and never spawn.
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-10/plugins/quirky.structured/main.ts`: create before runner.start; `runner.ts` and `claude-runner.ts` environment input; apply selected Claude config through runner environment, not launch hooks.
- Create `plugins/quirky.accounts/{quirky-plugin.json,package.json,main.ts,cli.ts}` and `src/{ui.tsx,types.ts,store.ts,service.ts,profiles.ts,login.ts,routing.ts,restarts.ts}`. Manifest UI is `dist/ui.js`; the existing UI builder discovers `src/ui.tsx`. File splitting within the component is delegated; contracts below are not.
- Create provider adapters/orchestration under `plugins/quirky.accounts/src/usage/`; account UI under `plugins/quirky.accounts/src/window/`.
- Existing tests: `plugins/quirky.session/test/sessions-launch.test.ts`, `packages/daemon/test/shell-path.test.ts`, plugin API UI model/host suites. New tests: `plugins/quirky.accounts/test/{accounts-api.test.ts,usage.test.ts,profiles.test.ts,restarts.test.ts}` and source-specific tests where consumer edge cases need isolation.
- Portable source map: Orca `src/shared/rate-limit-types.ts`; `src/main/rate-limits/{claude-*,codex-*,gemini-usage-fetcher.ts,gemini-oauth-sources.ts,antigravity-usage-fetcher.ts,antigravity-usage-response.ts,opencode-go-*,kimi-fetcher.ts,grok-fetcher.ts,grok-auth.ts,cursor-auth.ts,cursor-usage-mapping.ts,zcode-usage-fetcher.ts,zcode-usage-credentials.ts,minimax/}`. Mac credential service/hash rules: `src/main/claude-accounts/keychain.ts` and `src/main/macos-keychain/generic-password.ts`.
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-10/plugins/quirky.terminal/src/window/workspace/PaneLayer.tsx`: public per-session accessory host described above. Resolve declarations via public plugin.contributions and mount declared views via public mountView, preserving focus/layout behavior.
- `/Users/zpyoung/orca/workspaces/quirky/build-lane-10/plugins/quirky.agents/src/service.ts`: pure `plan` method returns `LaunchPlan.record.env`; use this public projection for explicit provider-home provenance, not a private configuration import. Existing `prepareLaunch`/`prepareResume` remain the real command planners.

## Contracts & interfaces

Implements [account identity/launch safety](logic.md#decisions-locked) and all [behavior criteria](logic.md#behavior-and-acceptance-scenarios).

### Required account preparation

`CONTRACT:` public method `quirky.accounts/prepare({agent:string,sessionId:string,worktreeId:string,cwd:string,homeOverrides:{claude:HomeOverride,codex:HomeOverride}}) -> {env:Record<string,string|null>,shellInit:string|null,account:{provider:'claude'|'codex',id:string|null,label:string,source:'managed'|'default'|'custom'}|null}`; `HomeOverride={value:string|null,source:'explicit'|'inherited'|'injected'|'absent'}`. Explicit non-injected launch-config home overrides win over managed selection; inherited homes define System default but do not override an explicitly selected managed account. Returned/stored identity describes the actual resolved home, not merely global selection.

For shell, return generated bash/zsh-compatible init file. Its claude/codex functions re-read atomic selection pointer on every invocation, delegate with command, scope env changes to a subshell and preserve explicit user overrides. Nonabsolute/missing/untrusted pointer fails safely. For agent, validate selected home and auth/ownership before returning env. Session create obtains explicit user environment from public agents/plan's launch record without invoking trust/setup; resume uses the original user launch record. Pass provider-home values/provenance to prepare before actual launch planning/trust/spawn, merge the resolved account patch into hook env, and do not store injected account env as user launch configuration. A present required method's error propagates; do not encode validation as a best-effort hook. Structured creation uses the same precedence/provenance contract.

### Account lifecycle and state API

`SCHEMA:` providers for managed operations are `claude|codex`; managed IDs are UUIDs restricted to ASCII alphanumerics, underscore and hyphen. Account summary fields: `id,provider,label,email,organization,createdAt,updatedAt,lastAuthenticatedAt,needsSignIn,active`. Paths and tokens are private.

`CONTRACT:` `list({provider?})` returns `{accounts,active:{claude:string|null,codex:string|null},systemDefault,pendingLogin,staleSessions,preferences}`. `usage({})` returns usage state. `refresh({provider?,force?:boolean})` returns updated usage; UI refresh passes force true. `inactiveUsage({provider})` expands inactive snapshots.

`SCHEMA:` shared `src/types.ts` exports `ManagedProvider='claude'|'codex'`; `AccountSummary={id:string,provider:ManagedProvider,label:string,email:string|null,organization:string|null,createdAt:number,updatedAt:number,lastAuthenticatedAt:number|null,needsSignIn:boolean,active:boolean}`; `SystemAccount={label:string,email:string|null,hasAuth:boolean,authKind:'oauth'|'api-key'|'none'|'unknown'}`; `PendingLogin={id:string,provider:ManagedProvider,accountId:string|null,status:'pending'|'complete'|'error'|'cancelled',url:string|null,error:string|null,result:AccountSummary|null}`.

`SCHEMA:` `Preferences={mode:'compact'|'detailed',direction:'used'|'remaining',hidden:boolean,visibleProviders:string[],density:'normal'|'icons',claudeSwitchPolicy:'ask'|'always'|'never',skipCodexResetConfirm:boolean}`. `StaleSession={sessionId:string,provider:ManagedProvider,accountId:string|null,accountLabel:string,selectedId:string|null,selectedLabel:string,busy:boolean,queued:boolean,kept:boolean,error:string|null,selectionRevision:number}`. `AccountState={accounts:AccountSummary[],active:{claude:string|null,codex:string|null},systemDefault:Record<ManagedProvider,SystemAccount>,pendingLogin:PendingLogin|null,staleSessions:StaleSession[],preferences:Preferences,revision:number,configWarnings:ConfigWarning[]}`. Provider filtering affects accounts/staleSessions only, never changes active/systemDefault shape.

`SCHEMA:` shared `ConfigWarning={provider:'codex',accountId:string|null,kind:'source-missing'|'source-empty'|'source-unreadable'|'sync-failed',message:string}`. Config synchronization on managed Codex prepare/selection retains last private settings on source/copy failure, returns safe warnings, and never replaces an OAuth managed profile's provider with a non-openai source. The private credential-store setting is always forced to file, including when the default config never existed. UI parses this shared field and shows account-relevant warnings in Codex settings. Implements [AC18](logic.md#ac18-retain-codex-settings-when-synchronization-fails).

`SCHEMA:` `AccountUiState={open:boolean,provider:string|null,expanded:ManagedProvider|null,settingsSection:string|null}`; `uiState({})` reads and `setUiState({open?,provider?,expanded?,settingsSection?})` patches daemon-owned transient state. Invalid values reject. `changed` carries `{revision:number}` and UI refetches generation-safely; `usageChanged` carries secret-free UsageState. Preferences/account identity persist; popover state resets on daemon restart. All method results/events use these shared shapes.

`CONTRACT:` `beginLogin({provider,label?,accountId?,copyLink?})` starts owned native CLI sign-in and returns pending ID immediately. `loginStatus({id})` returns pending/completed/error/cancelled plus safe trusted login URL; `cancelLogin({id})` terminates pending work, preserves committed sign-in. Reauth uses beginLogin accountId. `select({provider,accountId:string|null})` validates/commits selection and pointer, returns list plus affected sessions. `remove({provider,accountId,yes?:boolean})` uses existing confirmation convention then ownership-proven deletion, returns list. `setPreferences({mode?,direction?,hidden?,visibleProviders?,density?,claudeSwitchPolicy?,skipCodexResetConfirm?})` validates/updates durable preferences. Every method has a manifest schema, useful result schema and CLI command.

`CONTRACT:` `restart({sessions:string[],selectionRevision:number,yes?:boolean})` and `keep({sessions:string[],selectionRevision:number})` operate only on stale recorded sessions at that revision. Each queued Claude intention binds target account and revision. Later selection invalidates old intentions and recomputes choices under the current policy; never silently retarget an Ask-authorized restart. Busy Claude waits for idle; Codex restarts immediately. Validate providerSession/cwd/resumability using public APIs, kill old process through public pty.kill while retaining its record, resume using public session/resume, then close the old record and focus the new terminal session. Never run the same conversation concurrently. Failure leaves a visible retryable old record. Test A→B→C before idle.

`CONTRACT:` `ingestClaude({session,configDir,payload})` accepts authoritative rate_limits only for that session/account and current active target; dedupe and generation fences apply. Accounts subscribes to the authenticated hook.received event with source session-info-claude and consumes the identical payload emitted by the session-info-owned statusline wrapper. It does not install a second statusLine or duplicate --settings producer. Prior agent-status D29 assigns collection to session-info; concurrent lane6's reviewed tech contract explicitly supplies this event. If that producer is disabled, live readings stop and ordinary quota polling remains. Preserve its custom-command consent/display stdout and per-launch hook composition.

`CONTRACT:` credit offers include `expectedScope={accountId:string|null,accountRevision:number,offerRevision:string}`; `consumeResetCredit({idempotencyKey:string,expectedScope,yes?:boolean})` validates active identity/offer revision atomically before spend. Bind the ledger entry permanently to authorized scope; stale confirmation or retry after selection cannot spend another account's credit. Test confirm A→select B→submit, and repeated request ID across selection changes.

### Usage adapter boundary

`CONTRACT:` src/usage/index.ts exports UsageService, UsageTarget, UsageState and snapshot types. Constructor `new UsageService(context, targets:()=>Promise<UsageTarget[]>)`; methods `state():UsageState`, `refresh({provider?,force?}={}):Promise<UsageState>`, `inactive(provider):Promise<UsageState>`, `ingestClaude({session,configDir,payload}):boolean`, `consumeResetCredit({idempotencyKey,expectedScope,yes?}):Promise<unknown>`, `credentialStatus():CredentialStatus[]`, `setCredential({provider,kind,value}):CredentialStatus`, `clearCredential({provider,kind}):CredentialStatus`, `shutdown():void`. Internal credentials resolver is owned by usage module and is never returned through targets or snapshots.

`SCHEMA:` `UsageTarget={provider:string,accountId:string|null,home:string|null,active:boolean,label:string,revision?:number}`. The callback supplies active targets for all ten providers and inactive saved Claude/Codex homes; active managed providers receive AccountState.revision for reset authorization. Non-managed providers have accountId/home null; readers resolve native homes. No credentials pass through this boundary. `UsageState={providers:ProviderSnapshot[],inactive:Record<string,ProviderSnapshot>,updatedAt:number}`; providers are the ten IDs `claude,codex,gemini,antigravity,opencode-go,kimi,minimax,grok,cursor,zcode`.

`SCHEMA:` `ProviderSnapshot={provider,accountId,status:'idle'|'fetching'|'ok'|'error'|'unavailable',error:string|null,updatedAt:number,session:Window|null,weekly:Window|null,monthly?:Window|null,fableWeekly?:Window|null,buckets?:Bucket[],extraUsage?,rateLimitResetCredits?,planType?:string|null,usageMetadata?}`; `Window={usedPercent:number,windowMinutes:number,resetsAt:number|null,resetDescription:string|null}`; Bucket adds name/group/windowName. Map original Orca extras/provenance shapes consistently; percentages clamp finite 0..100, timestamps milliseconds.

Codex snapshots may expose accountRevision; every usable reset-credit offer carries rateLimitResetCredits.expectedScope with the exact account/offer revisions to submit. UI must not independently derive that scope. Gemini CLI OAuth is gated by setting:quirky.accounts/gemini-cli-oauth-enabled (boolean, default false); disabled adapters neither inspect nor refresh CLI OAuth. Opt-in is explicit in Accounts settings and may refresh the provider-owned Gemini credential file.

Adapters use Bun fetch with bounded abort and provider-owned subprocesses with bounded termination. Environment/OS home read at call time, never capture real HOME in fixture imports. Codex stdio App Server implements initialize/initialized/account/rateLimits/read and closes process. Cursor SQLite opens read-only; denied keychain falls through to live file/IDE source. Never have a generic no-op adapter standing in for the six less-documented providers.

Background job invokes refresh only with a focused visible window; manual refresh runs regardless. Single flight per provider/account, account-revision fences, Retry-After and stale policy are behavior, not independent global retry frameworks. Per-provider failure does not block other providers.

## Data models / schemas

Implements [data flow](logic.md#data-flow), [AC8](logic.md#ac8-cancel-failed-and-overlapping-sign-ins) and [AC13](logic.md#ac13-remove-accounts).

Private store migrations create account metadata/active selections/preferences, per-session account identities/restart intentions, quota snapshots and reset-credit ledger. No OAuth tokens in the database. Account homes are `<dataDir>/profiles/<provider>/<uuid>/home`; marker beside home names provider/id/version. Directories 0700, marker/config/pointers 0600; marker written after successful setup. Atomic pointer rename and settings transaction roll back together on failure. Homes are never user-provided deletion targets.

`CONTRACT:` schema-backed credentialStatus({}), setCredential({provider,kind,value:string}) and clearCredential({provider,kind}) delegate to UsageService. Allowed pairs: minimax api-key/cookie/group-id/base-url/model; opencode-go api-key/cookie; zcode api-key/base-url. Only allowlisted HTTPS provider base URLs are accepted. `CredentialStatus={provider:string,kind:string,configured:boolean,readable:boolean}` never returns value. UI password fields clear on successful submission; CLI reads secret from stdin/file, not argv examples or echoed output. Persist secrets through macOS Keychain or explicit owned 0600 file under 0700 dataDir; document local file threat model. Native login auth remains provider-owned. Test API/CLI configure→refresh→clear for all three configurable providers. Secrets never enter preferences/events/targets/snapshots.

## DO-NOT-CHANGE fences

Implements [hard identity and secret guarantees](logic.md#decisions-locked).

- `packages/daemon/src/plugins/launch-hooks.ts` best-effort/no-veto behavior and timeout/reserved-env rules: locked m0-daemon-api D19–D23. No required/fatal hook variant.
- User's `~/.claude` config/auth, `~/.codex/auth.json`, real `~/.quirky`, `~/.claude` and `~/.codex` during all tests: preserve the user's state and LOOP.md isolation requirement. History sharing is not permission to overwrite user files.
- `docs/loop/LOOP.md`, `scripts/build-loop/**`, `docs/loop/queue.json`, `docs/loop/DECISIONS.md`: protected automation/shared state.
- No main branch, push, new remote or working in integration worktree. Feature docs and original Orca source are read-only.
- Existing UI DOM structure is not an account plugin API; use declared host-owned slot roots only.

## Always / Ask / Never

Implements [decisions locked](logic.md#decisions-locked).

Always: native CLI authentication; required pre-spawn account validation; safe home ownership checks; serialized mutations; schema-declared API/CLI parity; immutable secret-free snapshots; isolated HOME and QUIRKY_HOME in every test subprocess; kill all owned subprocesses; adapt observed provider source rather than guessing formats.

Ask: no humans in this loop. Resolve ordinary implementation choices from code/source and record decisions; locked conflicts halt/block under LOOP.md.

Never: wrong-account fallback on unreadable selected home; copy default auth into a managed account; share credential files; expose raw provider errors/paths/tokens; send model prompts to get quota; pretend quota is zero when unknown; silent scope reduction; private cross-plugin implementation imports.

## Cross-cutting

Implements [secrets and mutation safety](logic.md#decisions-locked). Every provider transport is bounded; shutdown aborts probes/login. Redact network/filesystem errors into provider-specific safe strings. Handle late login/fetch responses using generation IDs so cancelled login cannot select a removed account. Account removal asks unless yes, and warnings say what is deleted. No new telemetry. Default auth/config hashes are fixture assertions before/after lifecycle and polling.

## Testing strategy

Implements [AC1–AC18](logic.md#behavior-and-acceptance-scenarios) and [Orca corrections](logic.md#orca-defects-and-corrections).

Use existing daemon/API fixtures with temp HOME/QUIRKY_HOME and deterministic fake external provider binaries/HTTP responses. Each AC must have at least one actual daemon API/CLI-driving test; tests of copies, schema wiring and source text are not acceptance. Add provider mapping/boundary tests for malformed/expired credentials, 429 dates, freshness/account-generation transitions, native probe cleanup, symlink replacement and failed identity preparation. Real PTY shell test must switch pointer after shell start and observe next invocation uses new private home, preserving explicit custom env. Restart test observes conversation ID/cwd/account, not a mock echo.

`plugins/quirky.accounts/test/acceptance-api.test.ts` and its isolated external-boundary fixtures fill daemon/API flow coverage that provider-unit and mounted-UI tests cannot substitute for. Include simultaneous pending additions/supersession, and valid-config→missing/empty source retention/warning transitions.

`COMMAND:` targeted `bun test plugins/quirky.accounts/test/accounts-api.test.ts`, `bun test plugins/quirky.accounts/test/usage.test.ts`, `bun test plugins/quirky.accounts/test/profiles.test.ts`, `bun test plugins/quirky.accounts/test/restarts.test.ts`, plus changed existing suites. Whole gate only `bun run test`, `bun test scripts`, `bun run typecheck`. Smoke actual built daemon/CLI against fixture provider homes and observe selection/routing/usage. UI: `bun run build`, isolated daemon, using-apps-like-a-user web unattended goals AC1/2/3/6/7/9/11/12/13/15; tool-caused blocked/partial gets exact report path. Native browser/Keychain dialogs get `docs/loop/native/m3-accounts.json` pending scenarios.

## Non-goals

See [scope](logic.md#scope-and-non-goals). No implementation of later remote hosting/WSL, analytics scanners or unrelated provider switchers. No generic security sandbox, OAuth broker or retry framework.
