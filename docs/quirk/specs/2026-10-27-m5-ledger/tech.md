# Project ledger implementation contracts

Status: Implemented with targeted verification; not cleared for landing or final code review because the required scripts gate is blocked. Logic: [logic.md](logic.md). Complexity gate: explicit LOOP.md request, >3 source files and daemon/UI/CLI boundary.

## Architecture

Implements [purpose](logic.md#purpose) and [data flow](logic.md#data-flow).

Create built-in `plugins/quirky.ledger/` with `main.ts`, `cli.ts`, `quirky-plugin.json`, `src/types.ts`, `src/daemon/{store,owners,engine,imports}.ts`, and `src/ui/` React components plus entry `src/ui.tsx`. No kernel ledger storage or imports from another plugin's private implementation. Register through ordinary plugin discovery and existing build mechanisms, extending explicit build lists only when the live tree requires it.

Use `PluginContext.openStore` and parameterized SQL. Separate ledgers, entries, history and anchors; JSON snapshots hold content/origin/actor/before/after. Queries should avoid loading every ledger's history. SQL transaction couples current state, history and counters; validate the complete bulk selection before any mutation. Enable foreign-key enforcement if relying on FK constraints. No network or helper process.

## Code references

Supports [scope](logic.md#scope--non-goals). Existing anchors are relative to repository root `/Users/zpyoung/orca/workspaces/quirky/build-lane-3`; created paths above are intentionally new.

- `packages/protocol/src/plugins.ts` `PluginContext`, `PluginStore`, `MethodHandler`, `PluginCaller`: public capabilities, synchronous transactions and authenticated caller context.
- `packages/protocol/src/ui.ts` `UiPluginContext`, `MountFunction`, `CommandHandler`: calls, subscriptions, routed commands, view inputs and slot reports.
- `packages/protocol/src/model.ts` `Repo`, `Worktree`, `ProjectGroup`: project/group/live workspace catalog. No ancestor field exists in the flat group model.
- `plugins/quirky.repo/main.ts` `activate`: public list/resolve/groupList registrations. `plugins/quirky.repo/src/projects.ts` `addRepo`, `removeRepo`: generated repo ids and changed event. `plugins/quirky.repo/src/groups.ts`: group deletion and membership.
- `plugins/quirky.worktree/main.ts` `activate`, `identityOf`: catalog consumption and workspace selector identity. `plugins/quirky.worktree/src/daemon/list.ts`: list API behavior.
- `plugins/quirky.worktree/src/{Menu,Tree,WorktreesSection,ProjectSettingsDialog,RemoveProjectDialog,GroupDialogs}.tsx`: project/group menus, settings and retention notices. Extend through public calls, not private ledger imports.
- `plugins/quirky.repo/cli.ts`: custom CLI facade conventions, `CliArgs`, `CliContext` formatting.
- `packages/daemon/test/helpers.ts` `startHarness`, `makeTempHome`, `builtinsDir`; `packages/ui/test/fixtures/headless-window.ts` `startHeadlessWindow`: daemon/API/window test harnesses.
- `plugins/quirky.worktree/test/window-projects.test.ts`: real owner menu scenarios. `plugins/quirky.repo/test/cli.test.ts`: actual spawned CLI patterns.
- `apps/desktop/src/bun/page.ts` `daemonUrl`: built-app browser smoke URL; use owned temporary daemon workflow from `docs/v1.md`.

## Contracts & interfaces

Implements [SC-01](logic.md#sc-01-file-every-type-validate-and-share-a-project-ledger) through [SC-12](logic.md#sc-12-explicit-detached-attachment).

### Shared request and response

`src/types.ts` owns exported ledger types shared only inside this plugin. JSON names follow the feature doc. Public names are `quirky.ledger/request` plus operation-named methods for discovery/generated commands; each operation method delegates to the same request engine, inserting its operation. `request` permits the full operation union. No arbitrary operation/action acceptance.

SCHEMA:
```ts
LedgerType = 'bug' | 'deferred' | 'test-gap' | 'proposal' | 'decision'
LedgerState = 'open' | 'resolved' | 'archived'
LedgerOwner = { tier: 'project' | 'group'; id: string }
LedgerTarget = { workspaceId?: string; owner?: LedgerOwner; ledgerId?: string; group?: boolean; groupSelector?: string }
LedgerLocation = { path: string; line?: number; base: { kind: 'project' | 'workspace'; id: string; host?: string }; external?: boolean; host?: string }
LedgerSelection = { id: string; revision: number }
LedgerRequest = { operation: 'file'|'list'|'show'|'edit'|'state'|'review'|'revert'|'import'|'catalog'|'approve'|'bulk-state'|'delete-entries'|'delete-ledger'|'attach'|'settings'|'removal-preview'; target?: LedgerTarget; type?: LedgerType; content?: Record<string, unknown>; id?: string; ifRevision?: number; toRevision?: number; state?: LedgerState; filters?: LedgerFilters; selections?: LedgerSelection[]; ifLedgerRevision?: number; attachTo?: LedgerOwner; confirmed?: boolean; staleAfterDays?: number; removal?: { repoIds?: string[]; groupIds?: string[]; expectedLedgers?: {ledgerId: string; revision: number}[] } }
LedgerFilters = { type?: LedgerType; state?: LedgerState; reviewed?: boolean; stale?: boolean; workspaceId?: string; branch?: string; search?: string; sort?: 'activity'|'sequence'|'title' }
LedgerResponse = { schemaVersion: 1; runtime: { runtimeId: string; profileId: string }; ledger: LedgerSummary|null; entry?: LedgerEntry; entries?: LedgerEntry[]; ledgers?: LedgerSummary[]; matches?: LedgerEntry[]; candidates?: LedgerCandidate[]; importResult?: ImportResult; removalPreview?: {ledgerId: string; revision: number; entryCount: number}[] }
ImportRecord = { type: LedgerType; content: Record<string, unknown>; sourcePath: string; sourceBase: LedgerLocation['base']; legacyId: string }
ImportSkip = { anchor?: string; reason: string; sourcePath?: string }
ImportResult = { created: string[]; updated: string[]; alreadyPresent: string[]; skipped: ImportSkip[] }
```

`LedgerEntry` has the feature-doc names id/type/sequence/revision/content/state/reviewed/origin/createdAt/updatedAt/history/latestContentActor. ISO times; history includes revision/at/actor/before/after/changedFields. Summary includes ledgerId/tier/owner/formerOwner/revision/entryCount/nextSequence/staleAfterDays plus display identity needed by the chooser. Include sourceEquivalences and metadata history on detail responses where relevant, not every entry row. Origin snapshots workspaceId, owner, branch, host, revision and observedAt. Actor contains kind, model/providerSessionId/tool when known, with import initiator. Never accept actor identity from request fields.

Runtime identity is explicitly plugin-scoped: generate runtimeId with randomUUID() once per activation, and persist one profileId UUID in plugin metadata on first store creation. It identifies this home's ledger store across restarts, not a global Orca profile. Label the tooltip accordingly. No private kernel introspection or fabricated system identifiers.

Required content: bug title/file/description/severity; deferred title/why_deferred/priority; test-gap title/file_under_test/reason_skipped; proposal title/context/recommendation; decision title/context/decision/consequences/status. Extra imported content survives. Text trims for validation; severity critical/high/medium/low, priority high/medium/low, decision status proposed/accepted/superseded. Edit cannot change type or identity.

### Errors and confirmation

Use `context.error` valid kinds invalid-params/not-found/conflict; add domain identifier in `error.data.kind` (and currentRevision/eligible where relevant). Domain identifiers: invalid-request, invalid-target, invalid-enum, conflict, not-found, workspace-missing, owner-missing, owner-ambiguous, group-missing, group-ambiguous, confirmation-required, attachment-refused, catalog-unavailable, incompatible-store. Persisted schema/content corruption must not be silently replaced. Transport RPC errors use existing protocol codes.

Declare destructive=true plus a public describe method on request and destructive operation wrappers. The describe method returns null for reversible operations, otherwise exact action text including ledger/entry revision snapshots. The standard dispatcher opens/binds an ask unless transport yes=true or an answered confirmation is supplied. There is no CliContext.confirm API. CLI calls ctx.call, which already applies --yes and confirmations; confirmed is only an engine consistency flag, never a dispatcher bypass. UI shows its explicit snapshot dialog, then calls with yes=true and confirmed=true; cancel sends nothing. Direct API callers need standard yes/confirmation as well as required snapshot fields. Stale metadata/entry snapshots are checked inside the mutation transaction.

### Owner/host boundary

`owners.ts` resolves catalogs using `context.call('quirky.repo/list')`, `groupList` and `quirky.worktree/list`/`show` public APIs. Pass caller cwd/worktree explicitly when invoking selector methods as a plugin, since `context.call` changes caller role. Reconcile startup, relevant changed events and requests, fencing stale catalog generations; do not detach everything on a failed catalog read. Preserve detached owner history and latch/report catalog-unavailable until a successful reconciliation.

Project ledger owner keys use a documented canonical identity: parse scp-style user@host:path and URL-style ssh/http/https remotes; drop credentials, transport and default ports (22/80/443), lowercase host, remove trailing slash and .git, preserve repository path case except lowercase github.com paths. Preserve nondefault port in the key. Local file/path remotes resolve relative to repo root and canonicalize to absolute realpath when present; no origin uses canonical repository root. Once a live repo id is mapped, retain that identity across remote edits until explicit detach/attach. Persist repo-id→identity mapping; do not migrate existing repo ids. Unique matching detached project recovers; ambiguous live mapping must not arbitrarily select a ledger. Resolve UI owner repo id to canonical ledger owner and retain live display name/path. Group owner ids remain catalog ids. Group workspaces resolve their group directly, ordinary workspaces use workspace override then repo membership. Folder workspaces have no project scope.

Locations parse trailing `:digits`, reject nonpositive/unsafe lines, normalize paths and base. External escape paths retain host identity; review never dereferences them. Read-only git commands stamp baseline/observed HEAD and remote origin for identity; failures reading HEAD give unavailable revision, not invented content. Canonicalize source/evidence paths to avoid following outside-root symlinks. Existing remote-routing errors remain explicit; no new remote implementation.

`removal-preview` returns impacted ledgers/revisions/counts and validates expectedLedgers when supplied. Extend repo/group removal public schemas and handlers to accept optional expected ledger snapshots; invoke the ledger public guard after other awaited teardown and before synchronous owner deletion. Only MethodNotFound permits omission when ledger is disabled, not arbitrary ledger errors. Retention notices are additive and feature-disable-safe.

### Import boundary

Implements [SC-08](logic.md#sc-08-legacy-formats-and-partial-failures) and [SC-09](logic.md#sc-09-idempotent-import-conflicts-and-tombstones).

CONTRACT:
```ts
readLegacyImports(root: string, base: LedgerLocation['base']): Promise<{ records: ImportRecord[]; skipped: ImportSkip[] }>
```

`imports.ts` exports that function. It only parses/reads; never opens ledger storage or applies revisions. It must report all copies of duplicate anchors as skipped and remove those records from returned records. Missing files are silent; other failures are skips. Parser recognizes tables/heading labels/bold labels and ADR YAML frontmatter/sections. Preserve extras. Base/host/source path/legacy id form the anchor; do not use row position or content hash as identity.

Engine owns validation, baseline/idempotency/equivalences/tombstones and per-record transactions. Normalize imported raw location strings using the filing workspace. A no-record import (even with read skips) does not allocate a ledger. Compare baseline content, not reviewed bit, to detect local content edits. Preserve independently committed earlier records after a later record failure. CLI prints import result and exits 1 for skipped records without converting success into an RPC failure.

### CLI boundary

Custom `cli.ts` facade uses declared cli-command entries and alias `ledger`; file/list/show/edit/state/review/revert/import plus catalog/approve/bulk-state/delete-entries/delete-ledger/attach/settings/removal-preview are scriptable. Preserve the feature-doc flag names, positional id or --id, mutually exclusive targeting and required flags. CLI maps flags to the request shape; request engine remains authoritative for revision/enum validation. CLI context cwd supplies default scope. `--workspace` is target for writes and a documented origin filter for list when explicitly combined with an owner/direct ledger target only if unambiguous; expose `--origin-workspace` separately to avoid ambiguous parsing. Structured JSON API always has separate target and filters. User-facing text uses concise entry lines and import counts. Use Quirky's standard JSON result formatting, not Orca's obsolete envelope.

## UI contracts

Implements [SC-13](logic.md#sc-13-panel-entry-points-scopes-and-states) through [SC-17](logic.md#sc-17-triage-and-settings-ui).

Manifest declares `view:quirky.ledger/ledger`, `panel:quirky.ledger/ledger`, `sidebar-section:quirky.ledger/ledger`, `command:quirky.ledger/open` (unbound), and `command:quirky.ledger/control`. Open accepts optional target and opens the chooser when absent. Mount input carries `{target?: LedgerTarget}`. Worktree menus open the public view using `{target:{owner:{tier,id}}}` with repo/group ids; no direct cross-plugin imports. Project settings can mount a declared ledger settings view through `context.mountView` so it remains replaceable/disable-safe.

Control command accepts a schema-declared action for scope/filter/sort/selection/detail/new/edit/triage/settings, and relevant target/id/filter/selection data. It updates the mounted feature controller using the same actions UI handlers use. Report visible target/scope/filters/sort/selection/dialog/entry id through mount `report` so `quirky ui state` exposes what is displayed. Persist layout through existing UI bridge, never mutate kernel internals. Unmounted control reports a clear error or opens the view first, not a silent no-op.

Render semantic labeled inputs/buttons, current revision and complete histories. Detail dialog uses a bounded flex column, min-height:0 scroll body and nonshrinking action footer. UI tests and browser smoke exercise long detail and reachable state/revert actions. Forms cover all types, historical location options, validation and duplicate hints. Selection confirmation lists exact snapshots; conflict reloads without reusing consent. Visible projections refresh from ledger changed/catalog changes and discard obsolete target responses; hidden panel does not retain active requests/listeners unnecessarily. Handle disabled ledger contribution through existing plugin host behavior.

## Data models / schemas

Implements [revision semantics](logic.md#sc-04-optimistic-edits-transitions-and-revert), [retention](logic.md#sc-11-owner-removal-retention-and-eager-recovery) and [restart](logic.md#sc-10-staleness-settings-and-durable-restart).

Store schema owns ledger identity/owner/former owner/revision/next sequence/staleness/equivalences/metadata history, current entry fields, entry history keyed ledger+entry+revision, import anchors keyed ledger+canonical source identity, tombstone flags/baselines, and persistent owner identity mappings. Entry history append-only until explicit entry/ledger deletion. No cascading deletion from repo/worktree stores. Ledger summary counts are derived or transactionally maintained. Sequence advances only on committed creation; deleted numbers are not reused. Version migrations are an ordered list to openStore. Validate loaded JSON/invariants and stop service with incompatible-store on corruption. Do not catch corruption as empty data.

## DO-NOT-CHANGE fences

Implements [scope](logic.md#scope--non-goals).

- `docs/loop/LOOP.md`, `scripts/build-loop/`, queue.json and DECISIONS.md: loop infrastructure is protected; only queue tool changes shared state.
- External feature docs: evidence is read-only.
- Core auth/confirmation semantics and plugin store ownership: locked platform invariants; no new trusted-UI bypass, helper process or direct kernel DB writes.
- Repo/Worktree/ProjectGroup ids and existing selector behavior: other features rely on them; maintain separate ledger identities, not a global ID migration.
- Unrelated plugin stores and private implementations: only public context.call/mountView interfaces cross plugin boundaries.

## Always / Ask / Never

Implements [decisions locked](logic.md#decisions-locked).

Always keep history/state/counters atomic; run real API/CLI flows in isolated homes; update all schema/CLI/UI callers together; record autonomous choices. Resolve build lists from live source rather than guessing.

Ask means record and choose autonomously per LOOP.md; a conflict with a locked architecture decision blocks the item, not a human prompt.

Never edit protected paths, real user profiles, source import files or main; never accept caller-asserted actor identity or invent evidence; never implement UI-only privileged operations; never suppress unexpected catalog/store errors as empty results.

## Cross-cutting

Implements [data flow](logic.md#data-flow). Existing unified token transport is the trust boundary. Bind provenance to supplied PluginCaller, distinguish UI/agent/unknown honestly, and avoid rendering legacy Markdown as executable HTML. Parameterize SQL and use canonical path containment before evidence/source reads. Store migrations are forward-only; disabling plugin preserves data. Rollback is disable/restore a compatible version, never silently downgrade a store. Emit one declared changed event after effective committed changes; listener failures do not roll back committed data. No new telemetry.

## Testing strategy

Implements all [acceptance scenarios](logic.md#behavior--acceptance-scenarios).

- `plugins/quirky.ledger/test/ledger.test.ts`: real daemon/API SC-01–07/10–12, state/revision/no-op/concurrency, lifecycle/recovery, settings, corrupt persistence, confirmation/atomic bulk and stable identity across re-add.
- `plugins/quirky.ledger/test/import-cli.test.ts`: real daemon plus spawned CLI SC-02/08/09; all types/legacy formats, idempotency/conflicts/tombstones/equivalence collisions, malformed imports/partial success exit, unchanged source bytes, positional ids and targeting.
- `plugins/quirky.ledger/test/window.test.ts`: real daemon and headless window; API-routed commands and DOM assertions for SC-13–17, owner menus/settings/retention, stale responses and footer/action availability. No source-text assertions or forwarding mocks.
- Existing worktree/repo tests remain behaviorally valid; update impacted contracts, never re-pin incidental wording tests.
- Orchestrator acceptance commands: `bun test plugins/quirky.ledger/test/ledger.test.ts`, `bun test plugins/quirky.ledger/test/import-cli.test.ts`, `bun test plugins/quirky.ledger/test/window.test.ts`, then affected package/app/plugin suites via `bun scripts/suite.ts <dir> ...`, `bun test scripts`, `bun run typecheck`, `bun run build`. Current LOOP.md reserves the whole `bun run test` suite for queue.ts land unless shared core code changes.
- Built web smoke: fresh owned QUIRKY_HOME, UI URL from daemonUrl, using-apps-like-a-user `--surface web --owner yours --unattended`, goals SC-13–17 including clipped-footer regression; clean up every owned process and temp home. Tool-caused blocked/partial is recorded with report, never claimed as passing.

## Non-goals

See [logic scope](logic.md#scope--non-goals): no remote-transport, hierarchical-group or unrelated kernel redesign; no compatibility shim for Orca IPC/HMAC/profile JSON; no new native-only scenario.
