# Provider, host and worktree remainder

## Status & amendments
Approved autonomously on 2026-10-28 under authoritative LOOP.md. One combined logic/technical spec; no human gate, research swarm or separate review. This item inherits the predecessor's entire Landing disposition. It does not assert exhaustive parity from a subset.

## Goal and conceptual model
Complete distinct missing provider, remote authority, per-window workspace, creation, naming and terminal flows through their existing public owners. Desktop people, CLI agents, automations and paired clients consume the same declared owner methods. Exact host, window, process and workspace identity is carried across every boundary; absence of evidence never becomes successful fallback or destructive authority.

## Decisions locked
- Authentication/integration: extend existing paired/federation authority, not a new crypto/transport implementation. Mobile-v2 remains its narrow device grant; remote owner administration requires a separately authenticated owner credential. Explicit nonlocal targets never execute locally. Remote provider hooks enter the existing authenticated normalizer and do not replace worker federation.
- Data/discovery: authoritative provider-owned nonempty complete model snapshots alone retire picks, scoped to their actual executing host and automation owner. Failed/empty/malformed/unsupported probes preserve catalogs and choices. Model settings, argv and one-shot recipes continue through the canonical resolver with raw > structured > inherited precedence.
- API/CLI: public namespaced schemas, existing request IDs/confirmation/error/JSON conventions. Target ambiguity or stale identities refuse; no arbitrary host label on local evidence. New view routes select a kernel UI connId, distinct from native auxiliary IDs.
- Visual/lifecycle: exact window view open/close/command and independent navigation history; sleep parks views only and compare-and-closes the inspected view. Hidden terminal resources unmount. Floating document authority comes from an explicit owned document root, not a synthetic workspace granting general disk access. Separate light/dark/custom terminal colors must not alter application theme.
- Creation/recovery: one canonical create/remove authority. Preflight invalid selected recipe/tab/host settings before mutation; setup trust remains mandatory. Prepared worktrees are detached, locked, bounded to three, expire after five minutes, and never claim a dirty/stale/mismatching checkout. Cleanup incorporates actual current volatile/connectivity evidence and never treats null as inactivity.
- Boundaries: retain landed phone origins/parking/tabs/Watch/artifacts/notifications; Browser controls/import/routing, editor leases, automation provenance/sidebar, dock, native clipboard, host-power and worker federation. Preserve locked macOS/hosting/Objective/sitter exclusions.
- Native external prerequisites: current signing inspection returned zero valid identities. Existing supported SDK lacks notification permission/click/dismiss callbacks; void showNotification is not delivery evidence. No private SDK/FFI fork, fake permission or invented production signing identity.

## Alternatives and rationale
1. Chosen: extend three existing-owner components in isolated worktrees, parent terminal integration; contract-first public window signatures. This preserves durable owner state and buys real parallelism.
2. Duplicate host/status/create/recipe stores or repurpose phone credentials: rejected, divergent authority and privilege escalation.
3. Treat earlier explicit unsupported errors or related SIXEL/summary features as parity: rejected, these are not the named consumer flows.

## Behavior and acceptance scenarios
Each shipped flow receives API/CLI consumer coverage for substantive boundaries/transition failures. Permanent tests are authored, not executed, in build-first. Parent exercises changed paths with disposable runtime smoke and runs typecheck. Native-only cases are handed to the existing native runner, not simulated.

### P1 — provider probes and exact-host retirement
Before: same agent saved on local and remote automation owners, seeded catalog and a saved model no longer offered. Walkthrough: refresh a real built-in provider's supported model-list operation, then empty/failing/malformed output and an unsupported remote target. After: successful nonempty snapshot updates only actual host catalog and retires only same-owner/agent/host stale model while retaining valid options; no remote label on local command, no changes on unsuccessful probe, no false host capability. Built-in unsupported protocols remain truthful, not invented commands.

### P2 — remote provider hook and full-owner CLI
Before: real paired runtimes with device grant versus separately authenticated owner access, exact session and process incarnations. Walkthrough: remote discover/launch/hook administration through existing owner, replace pairing/session and replay a stale envelope. After: real owner calls succeed only within their authentic grant; phone credential cannot become owner; no local fallback, secret output or duplicated worker status authority. Unsupported/missing authority refuses before execution.

### P3 — distinct naming recipes
Before: repo/global branchName and conversationName recipes with structured options and shadowing raw model/effort. Walkthrough: generate a branch name from actual branch/work prompt context and conversation name from actual captured conversation, via public UI/API/CLI. After: distinct bounded name result, correct contextual template and provenance, single canonical resolution, no automatic mutation of branch/session without explicit owned action; failed generation retains draft. Summary/reply draft is not a name.

### W1 — exact per-window navigation and sleep
Before: two connected windows on different workspace views and three known workspace rows. Walkthrough: navigate/back/forward/previous/next/index in a named connId, sleep that subtree, concurrently select another workspace, close a stale window. After: only named window changes; history is isolated, missing/stale window refuses; compare-and-close never closes newly selected view. Sleep preserves all PTYs, history, drafts, editor buffers and other-window views. Ambiguous untargeted calls refuse rather than selecting another window.

### W2 — authoritative identities and cleanup
Before: local desktop versus paired-phone origins, available actual hosts, volatile editor/terminal context and disconnected remote owner. Walkthrough: list/filter by real client/host, select available host, scan/dismiss/restore cleanup and remove from a fingerprint. After: genuine host/client evidence only; null remains unknown; volatile or disconnected/unknown remote context blocks canonical cleanup. Replaced evidence invalidates fingerprint; canonical removal rechecks safety.

### W3 — creation composition and prepared pool
Before: disposable repo, selected base/recipe/default tabs and a bounded prepared pool. Walkthrough: prefetch then create matching branch, create sparse/existing branch, expire or dirty a pool row, run trusted setup and selected env/tab composition, explicitly select remote host. After: exact prepared checkout safely claimed only when matching, pool bounded/expired cleaned, ordinary create fallback remains canonical. Recipe/tab selections actually apply through owners without duplicate prompts/focus theft; unsupported host refuses before local mutation, remote supported host uses real authority. Bad recipe/trust/tab input leaves no checkout.

### W4 — status/project controls
Before: custom status and project icon/tracker metadata. Walkthrough: change icon/avatar/emoji, select provider-backed tracker default, clear/restart/read. After: persisted safe identity reflected in board/sidebar and Settings/API/CLI; no executable URL or untrusted SVG/HTML injection, no fabricated tracker provider success.

### T1 — terminal rendering and appearance
Before: visible terminal with replay/history, hidden sibling and app light/dark themes. Walkthrough: display supported Kitty graphics, switch independent terminal dark/light/custom theme, hide/remount. After: bounded protocol resources, images and colors in actual terminal surface, no unbounded decode/hidden resources or history copy. SIXEL/iTerm path remains; unsupported Kitty operation cannot claim success.

### T2 — authorized floating destinations
Before: synthetic floating terminal and public editor/Markdown/Browser owners. Walkthrough: create/open Markdown or file and Browser destination in the captured floating group, hide/reveal/close. After: explicit authorized document root and exact hosted tab/group; original workspace/editor leases unaffected, filesystem stays scoped, existing Browser navigation/Native-vs-Watch policy retained. Distinct destinations not already shipped remain tracked individually.

### N1 — external native prerequisites
Before: current public SDK and production signing identity inventory. Walkthrough: inspect notification callbacks and codesigning authority without changing real state. After: unsupported permission/click/dismiss and unsigned production helper remain explicit prerequisites, not fabricated delivery/admission success. Reachable ordinary window/terminal source still ships separately.

## Source defects and invariants
Retain predecessor regression coverage for nonzero macOS exit, hidden view memory, canonical readiness/input fences, stale host/device/session, lossless history, unsafe delete/trust/prompt/focus and model singleton precedence. New cases cover local probing mislabeled as remote, cross-host catalog contamination, multi-window sleep/navigation affecting other window, malformed image allocation bounds, recipe invalidation before creation and same-owner retirement. Incidental schema/text/mock echo tests are not acceptance and are not repinned.

## Scope and non-goals
Every item in predecessor Landing disposition remains an obligation, including unstarted engineering and externally unavailable native flows. One implementation-only successor may carry exact unstarted/unavailable flows under LOOP; record a final exhaustive disposition, never call refusal implementation. No verification/debug/review successor. No Linux/Windows/WSL, excluded hosting/Objective/sitter/native chat/voice, private FFI/SDK patch or second transport.

## Industry insights
No research swarm under LOOP. Current feature docs, locked roadmap/architecture, prior decisions and a single read-only owner map are the research. Source observations do not prove runtime behavior.

## Deferred ideas and glossary
No additional feature ideas. Authoritative host: real execution owner, not caller-supplied display label. Window connId: live authenticated kernel UI connection; not native auxiliary window ID. Sleep: view parking, not stop/history/resume. Owner grant: separate authentication from mobile device grant. Unbuilt flows remain obligations.

## Technical decisions and contracts
- Shared signatures committed first in packages/protocol/src/window-routes.ts and rpc.ts, exported by index.ts: ui.window.state({connId}) -> UiState & {connId}; ui.window.view.open({connId,id,input?}) -> UiLayout; ui.window.view.close({connId,expectedView?}) -> UiLayout; ui.window.command.run({connId,id,args?}) -> {result}. Close compares complete expected view before mutation. Stale/missing/non-UI connId refuses. Unselected windows cannot receive target events or layout updates.
- Worktree public navigation/sleep gains optional numeric window selector mapped exactly to connId; singleton default preserves existing behavior, multiple-window untargeted refuses. C migrates all consumers; B owns actual kernel routing. No semantic dependency for source edits because shared signatures already committed.
- Component A: plugins/quirky.agents/**, quirky.automations/**, quirky.agent-status/**, quirky.git/**, quirky.orchestration/** only for authentic host discovery/status composition. Provider/automation/status/AI recipes, tests/docs/manifest. No CLI/protocol/worktree/terminal/editor edits.
- Component B: packages/cli/**, plugins/quirky.cli/**, packages/protocol/**, packages/daemon/**, packages/ui/**, apps/desktop/**, plugins/quirky.mobile/** only if adding a genuinely separate authenticated owner grant while leaving device grant unchanged. Own exact-window kernel/source and CLI administration. No A/C/terminal/editor/Browser edits.
- Component C: plugins/quirky.worktree/** and plugins/quirky.repo/** only. Canonical create pool, env/default tabs/project/status/evidence/navigation/sleep through public owner calls. No private cross-plugin imports; terminal composition methods must already exist or request parent contract.
- Parent: plugins/quirky.terminal/**, minimal authorized plugins/quirky.editor/** and quirky.browser/** destination composition, docs/decisions/root lock and final integration. Source additions audited against exact component scopes; no worker commits or checks mid-flight. At most three implementation dispatches concurrently, one isolated worktree per component.
- Build gate: bun run typecheck, then one roadmap catch-up immediately before landing and fresh merged typecheck. Narrow smoke uses fresh temporary HOME/QUIRKY_HOME, owned process cleanup. Permanent suites/reviews/dogfood stay end-phase. Native pending scenarios use docs/loop/native with actual limits.

## Self-review
All inherited flows have P1-P3/W1-W4/T1-T2/N1 ownership; no related feature is treated as a substitute. Native missing authority differs from reachable source engineering. Contracts are explicit and disjoint; no open human question or placeholder. Final landing disposition must state actual shipped flows and exact remaining flows with evidence rather than silently deleting acceptance scenarios.
