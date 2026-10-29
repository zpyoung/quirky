# Sidebar extras parity technical specification

Status: autonomously approved continuation; reviewed with sibling [logic spec](logic.md). Complexity gate: daemon/runtime and renderer boundaries. Existing public schemas stay unchanged.

## Architecture

Satisfies [conceptual model](logic.md#conceptual-model-and-data-flow). `plugins/quirky.sidebar-extras/main.ts` exposes state/set/activate/projection/dirty. `src/daemon/state.ts` persists client preferences/visits; `projection.ts` reads public runtime facts. `plugins/quirky.worktree/src/useSidebarActivity.ts` refreshes public projection on events and sixty-second interval; `Tree.tsx` owns membership interaction and `Menu.tsx` owns menu eligibility. No second state store or host mounting path.

## Code references

Satisfies [scenarios](logic.md#behavior--scenarios). Paths relative to repository root `/Users/zpyoung/orca/workspaces/quirky/build-lane-4`:

- `plugins/quirky.worktree/src/Menu.tsx`, `workspaceMenu` at33: eligibility at96 requires owning repo Git as well as worktree Git; missing-target removal at119 stays reachable; folder-owner project actions begin at123.
- `plugins/quirky.worktree/src/Tree.tsx`, preview reset at496, drag resolution at503, guarded mutation at520, and drop at862: share eligibility across start/preview/drop/mutation; recheck current `options.groupBy` at membership drag boundaries, not manual reorder boundaries.
- `plugins/quirky.worktree/src/ActivityFilters.tsx`: `WINDOW_OPTIONS` labels; change displayed rolling labels without changing six serialized window values.
- `plugins/quirky.worktree/src/useSidebarActivity.ts:227-232`: current sixty-second clock refresh and unmount cleanup; retain unless a regression proves a flaw.
- `plugins/quirky.sidebar-extras/src/daemon/projection.ts:72-158,235-272`: optional missing method differs from failed provider; positive live facts override unrelated failure. Agent status reads canonical freshness-adjusted display, not stale Session.agentStatus snapshots.
- `plugins/quirky.sidebar-extras/src/daemon/state.ts:181-207,291-365`: strict hydration, client identity, persistent visits and session exits.
- `plugins/quirky.sidebar-extras/test/activity.test.ts`, `api.test.ts`, `dirty.test.ts`, `ui.test.ts`: daemon/runtime/race edges.
- `plugins/quirky.worktree/test/sidebar-extras-ui.test.ts`: renderer interaction and quiet aging; `sidebar-extras.e2e.test.ts`: real daemon/CLI plus mounted window; `sidebar-membership.test.ts`: canonical identity/CAS; `plugins/quirky.repo/test/sidebar-groups.test.ts`: durable hierarchy/deletion.
- `plugins/quirky.worktree/main.ts`: the existing `ownedIds` provider is registered in the handler map, so folder/project ownership reads reach the canonical implementation.
- `plugins/quirky.worktree/src/daemon/project.ts:142`: hosting project resolution uses the public `path:` selector for the owning repo; normalized tracker identity persists without changing worktree lineage.
- `plugins/quirky.worktree/src/GroupDialogs.tsx`: a verified empty deletion preview discloses that no ledgers are affected; loading/error/null previews do not make that claim.
- `packages/ui/src/shell/ToolShell.tsx` and `tool-shell.css`: mount an effective distinct activity alias in the canonical stripe, with provider-owned control/decoration and existing drag/move behavior.
- `packages/daemon/src/plugins/layout.ts`, `stateFor`: available distinct activity aliases are visible independently of panel bodies; standalone activity-tool bodies still follow open state.
- `plugins/quirky.worktree/src/WorktreesSection.tsx`, `readSeparatorSetting`: a missing optional add-on declaration retains the existing default; unexpected getter failures still propagate.
- `packages/ui/src/design-system/overlays.tsx`, `Dialog`: preserve an already-focused child before applying the existing initial-focus fallback.

## Contracts & interfaces

Satisfies [locked decisions](logic.md#decisions-locked). Existing schema and API signatures are reused; no exported symbol rename or protocol migration.

- Menu eligibility: worktree.kind=git AND repo.kind=git. Unknown owner fails closed for membership and never fabricates successful assignment. Folder-owned rows use existing project actions when owner exists.
- Membership drag: only groupBy=project (use actual existing serialized value from sidebar options). Invalid source/mode produces no header preview and no membership mutation. Recheck at drop so switching modes mid-drag cannot commit stale eligibility. Manual sibling reorder retains its independent sortBy=manual behavior.
- Guarded mutation preserves expectedInstanceId/expectedProjectGroupId. Do not broaden loose membership to folders or change repoId/path/parentId.
- Serialized windows remain all/live-only/today/week/month/custom. Displayed labels express rolling durations. Tests may use accessible selectors to exercise them, not assert a copied menu inventory.
- Unknown runtime retains non-main rows per original tech.md69-71; main exception remains explicit. MethodNotFound means absent optional source. Ordinary provider failure means unavailable, not authoritative empty. No private browser store imports or persisted-tab-is-live inference: public browser pane/tab records alone do not expose an authoritative runtime-liveness predicate.
- Aliased activity presentation remains mounted in the canonical tool stripe independently of the tool panel. For an effective tool whose aliases include an available activity-item different from its body contribution, mount that public activity slot as the stripe control; retain the existing panel body, move menu and tool placement authority. Do not nest buttons or double-toggle the contributed action. Its live decoration replaces the cached host badge for that control, so closing a panel cannot freeze a stale badge beside it.
- Public slot state marks this aliased stripe activity visible even when the panel is closed. Standalone activity-tool bodies retain their existing open/close behavior; disabled/overridden activity mounts use existing PluginSlot cleanup and ownership checks. No new protocol field, registry, legacy rail or sidebar-extras-specific host import.
- Shared Dialog initial focus preserves an already-focused child, including the group-name field's native autoFocus/selection, instead of moving it to the header Close button. Keep existing fallback focus, trapping and stack cleanup; no caller-specific imperative focus workaround or new API.
- A core-only Worktrees UI must not require the optional sidebar-extras setting declaration. Only the public getter's exact known missing-declaration error selects the existing separator default; unexpected errors are not converted to a default.

## Data models / schemas

Satisfies [client state](logic.md#decisions-locked). No new data model. Existing `Preferences`, `ExtrasState`, `ActivityProjection`, canonical Worktree/Repo and expected membership CAS fields remain the contract. Invalid stored JSON and invalid custom days hydrate without mutation to safe defaults. API invalid values still reject, rather than silently applying defaults.

## DO-NOT-CHANGE fences

- `docs/loop/LOOP.md`, `scripts/build-loop/**`, shared queue and decision index: controller-owned protected paths.
- `packages/ui/**`, `packages/protocol/**`, daemon UI model/layout remain owned by the canonical shell. Direct SC-14/15 evidence permits the generic aliased-activity stripe mount/visibility repair; direct SC-01/05 evidence permits preserving already-focused Dialog children. Consume existing public IDs, props and lifecycle. No duplicate host, protocol migration, obsolete layout restoration or unrelated production-control changes.
- Existing group lifecycle/ledger retention guards and canonical CAS identity: preserve safety; only edit if direct scenario evidence demands a narrowly scoped repair.
- Review/automation filter policy: separate owners; preserve composition and independent hidden counts.

## Always / Ask / Never

Always use fresh owned HOME/QUIRKY_HOME, disable automatic hooks before activating plugins in fixtures, and clean all processes through ProcessScope/harness cleanup. Always preserve meaningful consumer assertions. Resolve all decision questions autonomously under LOOP.md and record them. Never ask a person, mutate actual user homes, weaken assertions to match a defect, or call private cross-plugin modules.

## Cross-cutting

Satisfies [scope](logic.md#scope--non-goals). No new privileges, remote credentials, persistence format or compatibility layer. Inherited `.serena/` is not this item's source. Browser and remote presence remain their owners' public facts; do not invent liveness from stored layout. Build/test commands use isolated Git defaults so test Git repositories do not inherit user identities/hooks.

## Testing strategy

Satisfies [all scenarios](logic.md#behavior--scenarios). First write targeted regressions for folder-owned Git-shaped rows and membership drag outside Project mode, and observe expected failures before implementation. Parent runs checks after the component barrier; workers do not run checks/formatters or commit. Runtime edge additions must drive real daemon API and test unknown boundaries/precedence, not mock forwarding.

Acceptance commands: `bun scripts/suite.ts plugins/quirky.worktree/test/sidebar-extras-ui.test.ts`; `bun scripts/suite.ts packages/ui packages/daemon plugins/quirky.sidebar-extras plugins/quirky.worktree plugins/quirky.repo`; `env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 bun scripts/suite.ts scripts`; `bun run typecheck`; `bun run build`. Full UI and daemon coverage includes the generic alias mount/visibility correction. The operator's 2026-10-28 routing override sends every test file, including scripts and single-file checks, through the remote suite; only the runner's macOS-only list and packaged native-app checks run here. Close each owned browser/daemon after its checks; do not run concurrent local browser fixtures. Run actual built web daemon on temporary home and unattended guarded user workflow for original visible scenarios; race/clock/provider-failure cases retain separate deterministic API/mounted-renderer evidence. Record tool limitations as such, never as passes. The corrective catch-up precedes final review; read incoming decisions and recheck affected scope. Perform one final cross-family discovery round and accepted fix batch, then re-run checks as LOOP.md directs.

## Non-goals

See [logic scope](logic.md#scope--non-goals). No shell redesign, browser runtime API expansion, native platform campaign, new test runner, unrelated test-triage fixes or full-suite repetitions outside controller requirements.
