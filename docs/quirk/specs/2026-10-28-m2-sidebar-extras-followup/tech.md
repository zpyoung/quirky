# Sidebar extras parity technical specification

Status: autonomously approved continuation; reviewed with sibling [logic spec](logic.md). Complexity gate: daemon/runtime and renderer boundaries. Existing public schemas stay unchanged.

## Architecture

Satisfies [conceptual model](logic.md#conceptual-model-and-data-flow). `plugins/quirky.sidebar-extras/main.ts` exposes state/set/activate/projection/dirty. `src/daemon/state.ts` persists client preferences/visits; `projection.ts` reads public runtime facts. `plugins/quirky.worktree/src/useSidebarActivity.ts` refreshes public projection on events and sixty-second interval; `Tree.tsx` owns membership interaction and `Menu.tsx` owns menu eligibility. No second state store or host mounting path.

## Code references

Satisfies [scenarios](logic.md#behavior--scenarios). Paths relative to repository root `/Users/zpyoung/orca/workspaces/quirky/build-lane-4`:

- `plugins/quirky.worktree/src/Menu.tsx`, `workspaceMenu(worktree, descendants, groups, repo, on, statuses)` at132: eligibility branch at199 requires owning repo Git as well as worktree Git; fallback uses existing project actions.
- `plugins/quirky.worktree/src/Tree.tsx`, `changeMembership` at412, drag resolution near395 and handlers715: share eligibility across start/preview/drop/mutation; check current `options.groupBy` at membership drag boundaries, not manual reorder boundaries.
- `plugins/quirky.worktree/src/ActivityFilters.tsx`: `WINDOW_OPTIONS` labels; change displayed rolling labels without changing six serialized window values.
- `plugins/quirky.worktree/src/useSidebarActivity.ts:227-232`: current sixty-second clock refresh and unmount cleanup; retain unless a regression proves a flaw.
- `plugins/quirky.sidebar-extras/src/daemon/projection.ts:72-158,235-272`: optional missing method differs from failed provider; positive live facts override unrelated failure. Agent status reads canonical freshness-adjusted display, not stale Session.agentStatus snapshots.
- `plugins/quirky.sidebar-extras/src/daemon/state.ts:181-207,291-365`: strict hydration, client identity, persistent visits and session exits.
- `plugins/quirky.sidebar-extras/test/activity.test.ts`, `api.test.ts`, `dirty.test.ts`, `ui.test.ts`: daemon/runtime/race edges.
- `plugins/quirky.worktree/test/sidebar-extras-ui.test.ts`: renderer interaction and quiet aging; `sidebar-extras.e2e.test.ts`: real daemon/CLI plus mounted window; `sidebar-membership.test.ts`: canonical identity/CAS; `plugins/quirky.repo/test/sidebar-groups.test.ts`: durable hierarchy/deletion.

## Contracts & interfaces

Satisfies [locked decisions](logic.md#decisions-locked). Existing schema and API signatures are reused; no exported symbol rename or protocol migration.

- Menu eligibility: worktree.kind=git AND repo.kind=git. Unknown owner fails closed for membership and never fabricates successful assignment. Folder-owned rows use existing project actions when owner exists.
- Membership drag: only groupBy=project (use actual existing serialized value from sidebar options). Invalid source/mode produces no header preview and no membership mutation. Recheck at drop so switching modes mid-drag cannot commit stale eligibility. Manual sibling reorder retains its independent sortBy=manual behavior.
- Guarded mutation preserves expectedInstanceId/expectedProjectGroupId. Do not broaden loose membership to folders or change repoId/path/parentId.
- Serialized windows remain all/live-only/today/week/month/custom. Displayed labels express rolling durations. Tests may use accessible selectors to exercise them, not assert a copied menu inventory.
- Unknown runtime retains non-main rows per original tech.md69-71; main exception remains explicit. MethodNotFound means absent optional source. Ordinary provider failure means unavailable, not authoritative empty. No private browser store imports or persisted-tab-is-live inference: public browser pane/tab records alone do not expose an authoritative runtime-liveness predicate.

## Data models / schemas

Satisfies [client state](logic.md#decisions-locked). No new data model. Existing `Preferences`, `ExtrasState`, `ActivityProjection`, canonical Worktree/Repo and expected membership CAS fields remain the contract. Invalid stored JSON and invalid custom days hydrate without mutation to safe defaults. API invalid values still reject, rather than silently applying defaults.

## DO-NOT-CHANGE fences

- `docs/loop/LOOP.md`, `scripts/build-loop/**`, shared queue and decision index: controller-owned protected paths.
- `packages/ui/**`, `packages/protocol/**`, daemon UI model/layout: concurrent shell-slot owner; consume public contributions, do not implement duplicate host mounting.
- Existing group lifecycle/ledger retention guards and canonical CAS identity: preserve safety; only edit if direct scenario evidence demands a narrowly scoped repair.
- Review/automation filter policy: separate owners; preserve composition and independent hidden counts.

## Always / Ask / Never

Always use fresh owned HOME/QUIRKY_HOME, disable automatic hooks before activating plugins in fixtures, and clean all processes through ProcessScope/harness cleanup. Always preserve meaningful consumer assertions. Resolve all decision questions autonomously under LOOP.md and record them. Never ask a person, mutate actual user homes, weaken assertions to match a defect, or call private cross-plugin modules.

## Cross-cutting

Satisfies [scope](logic.md#scope--non-goals). No new privileges, remote credentials, persistence format or compatibility layer. Inherited `.serena/` is not this item's source. Browser and remote presence remain their owners' public facts; do not invent liveness from stored layout. Build/test commands use isolated Git defaults so test Git repositories do not inherit user identities/hooks.

## Testing strategy

Satisfies [all scenarios](logic.md#behavior--scenarios). First write targeted regressions for folder-owned Git-shaped rows and membership drag outside Project mode, and observe expected failures before implementation. Parent runs checks after the component barrier; workers do not run checks/formatters or commit. Runtime edge additions must drive real daemon API and test unknown boundaries/precedence, not mock forwarding.

Acceptance commands: `bun test plugins/quirky.worktree/test/sidebar-extras-ui.test.ts`; `bun scripts/suite.ts plugins/quirky.sidebar-extras plugins/quirky.worktree plugins/quirky.repo`; `env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 bun test scripts`; `bun run typecheck`; `bun run build`. Run actual built web daemon on temporary home and unattended guarded user workflow for original visible scenarios; race/clock/provider-failure cases retain separate deterministic API/mounted-renderer evidence. Record tool limitations as such, never as passes. Catch up once immediately before landing, read incoming decisions, recheck affected scope. Perform one final cross-family discovery round and accepted fix batch, then re-run checks as LOOP.md directs.

## Non-goals

See [logic scope](logic.md#scope--non-goals). No shell redesign, browser runtime API expansion, native platform campaign, new test runner, unrelated test-triage fixes or full-suite repetitions outside controller requirements.
