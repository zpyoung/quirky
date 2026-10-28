# Vault parity completion

## Conceptual model
Vault remains a view over agent-owned transcripts, with a disposable browse cache and separately consented full-text index. This item completes the matrix explicitly left by the core landing, rather than replacing its architecture or treating API proof as browser proof.

## Scope and non-goals
Acceptance is SC-02/03/06/08/10/11/15/16/18/19/20/21/22/23/24 from [the original scenario catalog](../2026-10-27-m3-vault/logic.md#behavior-and-acceptance-scenarios), plus nightly SC-17/18 native handoff. The source is `/Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/orca-features/ai-vault.md`. Preserve all25 source formats and original bytes. No new indexing policy, transport, native chat, SSH/WSL, Linux/Windows support or separately queued consent-tip work.

## Data flow
Authenticated clients call the existing Vault methods. Service scope/host routing remains in the daemon; discovery, parsing and FTS remain in its lazy Worker. UI consumes canonical envelopes and reports daemon-owned selection/filter/focus. Actions revalidate source identity and call the existing session/terminal/handoff owners. Restarted workers recover source identities from owned on-disk metadata, never untrusted caller paths.

## Key decisions and rationale
Recommended: extend the landed feature and exercise real filesystem/daemon/CLI/browser paths. A rewrite would discard proven consent and ownership boundaries. Merely documenting absent proof would not satisfy the queued flows. Synthetic transport/Worker fault inputs are allowed only to drive real consumer error handling; successful scans, indexing, launches and handoffs must use the real implementation and owned provider processes.

## Decisions locked
- **Visual:** retain source defaults and stable view persistence; compact narrow header, bounded rendered history, visible reachable action menus/details, explicit empty/loading/degraded/error/limit states. Selection is identity-based across group, page and refresh changes.
- **API:** canonical existing envelopes; unknown scopes never widen. Stale pages replace page1, not append. No automatic destructive-action replay.
- **CLI:** every declared inspect/resume/action/UI subcommand executes against actual API/window state; bad arguments fail nonzero without mutation.
- **Data:** source transcripts are authoritative. Rewrite/truncate/replacement/sidecar/SQLite mutations reconcile; failure holdout ends when source signature changes; schema rebuild affects derived data only.
- **Integration:** source agent/provider/path/cwd survive archived handoff through its owner's SourceRef; no fabricated live session identity. Same-token web clients have normal local authority. Host-qualified identities/redaction survive aggregation.
- **Native:** unattended web work never takes foreground. Native scenarios are pending handoffs, not passing web claims.

## Behavior and acceptance scenarios
Each row inherits the complete named original scenario and tightens the missing proof. API/CLI scenarios use real temporary daemon/source homes; visible scenarios additionally run on the built web surface.

| Scenario | Before / walkthrough | Required after |
|---|---|---|
| SC-02 | Create real registered project/worktree plus old local history and >250 newer unrelated sessions; open contextual history, switch Workspace/Project/All. | Workspace initially selected with active worktree, Project without worktree when project exists, otherwise All. Old scoped row survives depth; Project includes its worktrees only; unavailable scopes remain bounded. |
| SC-03 | Mixed agents/empty sessions; change all filters, each group/depth and browse/search sort, reset, show-more and restart. | Lists reflect each control, stable choices survive restart, contextual scope recomputes, reset restores default badge/options and show-more increases depth. |
| SC-06 | Large grouped history in wide then <300px panel; scroll, collapse/expand groups and expand different selected rows. | Compact Agents header; bounded DOM rows; selected identity/details never silently switch to another row. |
| SC-08 | Enable indexing over real fixtures, observe current and deliberately unreadable sources; open sidebar from Settings. | Indexed/owed/message/failed/root counts are honest; indexing polls2s and settled10s; Open focuses visible search. |
| SC-10/11 | For JSONL, JSON, sidecar and SQLite sources append/rewrite/truncate/replace/change metadata; repeat a failing source, change it, make roots unavailable and delete a known file; replace derived schema and restart/crash Worker. | New text/title replaces old answers; unchanged sources skip reads; three unchanged failures held out until signature change; retention preserves originals; healthy results survive root failure; schema rebuild and later Worker reads recover honestly, pending failures never report success. |
| SC-15/16 | Load multiple search pages, mutate index then load more; exercise each unavailable/limit/connection-failure state and retry. | Old pages are replaced with current page1; no duplicate stale append. Empty differs from failure; each actual limitation/host outcome is visible and retry recovers without widening scope. |
| SC-18 | Expand long-prompt session/Claude and OMP children; restart Worker then inspect selected child directly. Copy prompt/ID/path/command; view/open/reveal source, open cwd and jump to live pane/worktree/folder. | Full literal selected content is targeted; child resolves without caller first re-listing parent; visible actions remain reachable; public owner focus reflects exact live identity; failures do not toast success. |
| SC-19 | Decline confirmation, swap selected source to symlink, then confirm valid file/directory deletion while list/index work overlaps, on disposable APFS volume. | Cancel/rejection preserves source/outside sentinel. Actual valid targets reach owned Trash; stale caches/index cannot resurrect them; repeat missing deletion succeeds honestly. |
| SC-20 | Real-browser Up/Down/Enter, then drag history title onto nonactive terminal group using owned fake provider executable. | Exact selected source resumes once; returned live tab is in explicit drop group; logged provider argv/cwd match, unavailable rows cannot launch. |
| SC-21 | Session Info Open Vault then enabled archived handoff; disable owner and retry. | Correct agent/provider preselection and search focus; actual owner dialog/flow receives archived source context, never opaque Vault ID as live session. Disabled owner remains honestly unavailable. |
| SC-22 | Drive every declared vault inspect/resume/action/view/window subcommand against real daemon/window. | Results/state/source identity agree; launches execute owned provider; invalid query/status/timestamp/path-count combinations fail nonzero with no side effects. |
| SC-23 | Local, All and real contributed authenticated host controls; one host unavailable; enable-all then use authenticated web controls. | Local first, then remote enablement; identities/partial failure visible; remote paths/commands/root paths redacted; no invented desktop-only denial or transport. |
| SC-24 | Built daemon unused, browse then leave idle through actual retirement deadline, enable index across idle, deactivate/reactivate, fault Worker and shut down. | Lazy no-worker/no-index initial state; packaged worker path works; browse-only retirement recovers, enabled index stays available; pending failures settle honestly; teardown leaves no owned resources. |
| SC-17/18 native | Nightly isolated packaged profile performs terminal focus, Finder reveal/cwd open and literal macOS clipboard checks after visible menu fixes. | Fresh pending native scenario definitions with exact targets; no foreground/native pass claimed by this unattended lane. |

## Defects and boundary regressions
The feature document has no separately labelled defect list. Its verified differences remain requirements: first-prompt copy must be reachable; configured provider resume arguments remain literal; quoted search retains fallback semantics; history-depth/show-more controls remain present. Native run recorded clipped Copy Log Path and missing visible Copy First Prompt: repair reachability and retain fresh native handoff. No accidental indexing, source deletion, scope widening, arbitrary command drag, unescaped HTML, account preparation bypass or clear-triggered rebuild is authorized.

## Industry insights
Reuse source-grounded research already recorded in the original spec: SQLite FTS5 escaped query planning, generation/incarnation paging, Bun Worker ownership and explicit packaged Worker assets. No new research swarm under LOOP.md.

## Deferred ideas
None added. Explicit platform exclusions and the independent consent-tip completion remain with their assigned items. Native-only execution follows the required nightly handoff, not a silent omission.

## Glossary
- **Source identity:** agent plus canonical provider transcript/session, independent of title and tab.
- **Hosted ID:** opaque host-qualified source ID; not a live Quirky session ID.
- **Archived SourceRef:** handoff-owned `{archived:{agent,providerSessionId?,transcriptPath?,title?,worktree?,cwd?,prompt?,lastMessage?}}`.
- **Unverifiable:** availability cannot be proven; not equivalent to deleted.

## Technical decisions and contracts
The original [technical contracts](../2026-10-27-m3-vault/tech.md#contracts-and-interfaces) remain binding. No public Vault type/result-envelope changes are planned. `get`, `firstPrompt`, `subagents` must resolve a previously issued child ID after Worker restart without trusting an arbitrary caller path. Internal persisted derived metadata may support this, but validate roots/kinds/parent ownership again.

Archived handoff must consume the existing handoff SourceRef, retain provider identity/path/cwd/title/full first prompt/latest assistant context, and route to the handoff owner's real window command/API. The owner's live-session opening remains valid; add archived opening through its source-aware model rather than pretending an archived provider ID is a live session. Enumerate/migrate all changed owner callers. Public capability discovery must use effective contributions, never private cross-plugin source imports.

Three disjoint components, no semantic dependency edges: A owns Vault `src/window/**`, `src/ui.tsx`, `test/window.test.ts` plus new window-parity tests; B owns `src/scanner/**`, `src/search/**`, `src/worker{,-client}.ts` and scanner/search/lifecycle/availability/Worker tests plus new recovery tests; C owns `actions.ts`, `service.ts`, `hosts.ts`, `view-state.ts`, `cli.ts`, manifest and action/API/CLI/scope/flows tests plus narrowly required session/handoff public integration. Existing `src/types.ts`/source inventory remain parent-owned; request any incompatible change before editing. Test support/harness/fixtures ownership is B, C creates own adjacent helper if needed; A creates own window fixtures. No shared test files or broad owner refactors.

Component work uses external temporary worktrees. Implementers do not commit/build/lint/run tests mid-flight; parent runs owned-file acceptance at the barrier (higher-priority task-tool contract). For bugs, leave a regression that proves consumer-visible behavior; parent can exercise failing baseline before acceptance. Required final commands: `bun scripts/suite.ts plugins/quirky.vault plugins/quirky.handoff plugins/quirky.session plugins/quirky.terminal`, `bun test scripts`, `bun run typecheck`, `bun run build`. Expand affected directories only if actual edits/imports require it. Whole suite belongs to supported queue land. Built web dogfood runs once after integration with owned HOME/XDG/QUIRKY_HOME/source homes, absolute fake provider, no Accounts/Hosting startup side effects; real multi-host fixtures use current shared transport. Remove owned temporary homes/processes after proof.

## Status & amendments
Status: Approved autonomously per LOOP.md. Combined technical section replaces separate tech.md under the authoritative loop override; source/contract self-review completed before implementation.

**Amendments:** 2026-10-28 — Initial completion contract, preserving the original catalog and explicitly carrying every queued obligation.
