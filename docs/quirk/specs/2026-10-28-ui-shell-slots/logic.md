# Six-slot desktop shell

Status: Approved autonomous execution of the approved [UI redesign](../2026-10-28-ui-redesign/logic.md), 2026-10-28. One combined logic/technical spec under build-first rules.

## Goal and conceptual model

The host owns window chrome. Effective plugin contributions become tools, center views, commands, status items, settings and overlays. Six stripes replace both the top plugin navigation row and sidebar launcher piles. Existing plugin feature content and authority stay with their current owners.

The daemon owns the layout in the profile's existing ui_state row. This is user/profile-wide, not worktree-specific. A stripe has one icon per tool; a slot displays at most one tool. Opening a tool replaces its slot's occupant; clicking it again closes that slot. Moving a tool changes its persistent placement and moves an open tool atomically. Both vertical slots on one side remain visible, separated by a resizable split. The bottom has independently selectable left/right slots. Dimensions and splits survive reload.

First use opens Worktrees in left-top and Changes in right-top only. Defaults follow the approved slot table. Registered panels and substantive sidebar content remain reachable; duplicate launchers map to their feature's full panel/view rather than becoming redundant tools. Unrecognized third-party sidebar/activity contributions remain tools rather than disappearing. Settings and overlays keep their host-owned regions; commands remain searchable. No plugin rendering is allowed outside a host contribution boundary.

## Key decisions and rationale

- Use an additive tool projection over the existing registry, not a second contribution registry or a mass renaming of plugin IDs. Original IDs continue to identify plugin code, reports and commands. Alias IDs describe multiple existing registration destinations for the same tool, not deprecated API shims.
- Extend the existing daemon layout service rather than browser-local storage. Existing public panel/sidebar calls mutate the same tool state, so plugins and CLI cannot disagree with stripes. Exact-window view/focus isolation must remain intact.
- Keep plugin-owned terminal/editor/browser internal tab behaviors intact. Host center tabs represent actually opened view contributions and retain their inputs; they are not a row containing every installed plugin. Detailed feature tab restyles belong to their approved area items.
- Inbox is a host tool. Its actionable questions come from canonical pending asks, not a copied authority store. Expiring or dismissing a toast never answers/cancels an ask. Answer buttons use the existing canonical answer path. Counts derive from unresolved records and existing badges.
- Reuse all shared design-system controls and tokens. Shell CSS belongs to packages/ui and has no raw color/pixel literals. Preserve system/dark/light resolution from the dependency.
- Alternative: replace every plugin registration now. Rejected: destroys stable IDs, increases collision with area owners, and changes feature behavior. Alternative: CSS-only reposition the old sidebar and top tabs. Rejected: cannot express independent open slots or durable drag placement.

## Behavior and acceptance criteria

SC1. Fresh user: Worktrees left-top and Changes right-top open; all other slots closed. No top plugin tab bar, separate activity pile or sidebar launcher pile remains outside tools. Existing settings remain reachable.

SC2. Click Tasks then Automations in left-bottom: only Automations displays there, while Worktrees remains visible above. Clicking Automations again closes only left-bottom. Each slot's icons expose accessible labels and selected state.

SC3. Drag Ledger from bottom-left to right-bottom: Ledger disappears from the old stripe, appears once in the destination, opens there if it was open, and stays there on refresh/restart. External or unknown drag IDs cannot corrupt layout. Keyboard/menu move controls offer the same reachable behavior.

SC4. Resize left/right/bottom and split two tools: values are bounded, persist profile-wide and do not create horizontal overflow in a small viewport. A stored corrupt/disabled tool is removed from effective rendering without discarding unrelated preferences. New tools get defaults without reopening a slot explicitly closed by the user.

SC5. Registration coverage: all effective panel/sidebar/activity contributions have a destination (direct tool or explicit deduplicated alias); view registrations remain center view types, commands appear in search, status registrations render in the status bar, settings and overlays retain their dedicated hosts. A failed plugin shows its name and Reload within only its tool. Other tools/views remain usable.

SC6. Titlebar displays canonical selected project/worktree breadcrumb and a command-search trigger labeled ⌘K. Existing shortcuts remain; ⌘K opens search without bypassing focused editor/terminal rules. Search contains commands, tools, views and worktrees; worktree activation uses the canonical selection API, never local selection. A search with no matches displays "No results" after worktrees load successfully.

SC7. Center tabs show actually opened view contributions, preserve input when switching and close through the exact current window's route. Moving focus between a tool and the center keeps the active view mounted, preserving drafts and embedded state. Auxiliary windows retain their exact-window behavior and do not acquire global tool chrome or change other windows' views.

SC8. A question from another worktree increases Inbox and existing worktree attention without changing the selected worktree/view. A bottom-right shared toast exposes the question and primary answer. At eight seconds only the toast disappears; the question remains in Inbox. Successful answer removes the pending entry through canonical events; failure leaves the question actionable and reports the error. No fake answer or synthesized success.

SC9. Status bar combines existing registered status content with canonical branch/working/needs-you summaries where available. Summary labels stay on one line; the branch ellipsizes before activity counts lose space, and constrained summaries clip rather than overlap plugin content. Unknown/offline values are not invented. Theme switch changes chrome through the existing token resolver.

## Defect coverage

Retain regressions for independent simultaneous side slots; toggling the wrong slot; loss of moved-tool placement across daemon recreation; duplicate launcher aliases; stale disabled IDs; invalid dimensions/drag targets; per-worktree layout resets; toast expiration mistakenly resolving an ask; failed answer losing the question; failed plugin breaking other tools; exact-window tab cross-talk; loss of view input; raw shell CSS literals. Tests assert observable state/transitions, not source strings or forwarding copies.

## Scope and non-goals

This item implements host structure and contribution mapping. It does not restyle plugin feature interiors, change phone UI, replace terminal/provider state, add floating tool windows, change OS notifications or introduce a new notification authority. Existing native notification delivery remains unchanged. Screenshot scoring campaigns, suites, full dogfood and adversarial review are not run in build-first; they belong to the end phase. Minimum real changed-surface smoke and typecheck still run under the coding contract. No unimplemented flow is silently labeled complete.

## Technical decisions and contracts

Shared types are committed before implementers in packages/protocol/src/tool-slots.ts, ui.ts, rpc.ts and index.ts. UiModel.tools projects entries with id/title/icon/defaultSlot/contributionId/aliases. Host Inbox uses id host:inbox and contributionId:null. UiLayout.tools contains placements, order, all six open slots, sizes left/right/bottom and leftSplit/rightSplit/bottomSplit. Layout retains existing public view/panel/sidebar/focus fields. UiLayout.viewTabs retains actually opened view IDs and their latest inputs; exact-window overrides must include this list rather than leaking global view history.

Public methods: ui.tool.open({id}), ui.tool.close({slot}), ui.tool.move({id,slot}), ui.tool.resize(partial sizes), all returning UiLayout. Unknown IDs fail NotFound; bad slots/geometry fail InvalidParams; all mutations validate against current effective tools and publish existing ui.state.changed. Geometry: widths 160–1200, bottom height 100–1000, splits 0.15–0.85; viewport rendering may contract further without persisting impossible viewport sizes. Resize input contains at least one own valid numeric field; nonfinite values are rejected. Existing ui.panel/sidebar methods update the same tool state and report current tool visibility.

Mount and focus contract: render the active center contribution with the stable input from `layout.view` (or its exact auxiliary-window route), not a newly decoded `viewTabs` history entry. History entries supply input when selecting a different tab; an actual input change still remounts the contribution. Tool content participates in the existing `panel` focus region, so tool clicks and public focus calls share one authority.

Three disjoint implementer components: (A) daemon/protocol schemas/projection/CLI and acceptance tests, (B) App/host/slot shell/style and slot tests, (C) attention/palette/main center tabs/title+status and their tests. B imports ShellTitleBar, ShellStatusBar and InboxPanel from src/shell/ShellChrome.tsx (C owns); all are zero-required-prop components. B passes a Settings trigger callback as optional onSettings to ShellTitleBar. B owns WindowPluginHost openTool(id), closeTool(slot), moveTool(id,slot), resizeTools(patch) public methods, forwarding canonical RPC; C consumes them. Parent owns contracts and integration corrections after all workers stop.

Build-first verification: workers write tests but run no checks/build/lint/formatters and never stage/commit. Parent audits exact HEAD/path boundaries, integrates, runs bun run typecheck, minimal UI build and isolated actual shell smoke in fresh temporary QUIRKY_HOME (no real state), then catches up build/roadmap once, reads new binding decisions and reruns typecheck. Screenshot review is not claimed.

## Industry Insights

Reuse the approved parent spec's documented PyCharm/Linear/Zed/VSCode patterns. No new research swarm under build-first.

## Deferred Ideas

None added. Existing area-restyle and screenshot-review owners retain their planned work.

## Glossary

Tool: host-owned slot frame around plugin content. Stripe: the tool's placement selector. Inbox: canonical unresolved attention projection. View tab: actually opened center contribution with its input, distinct from plugin-internal document/session tabs.

## Self-review and amendments

2026-10-28: checked against parent shell regions, six-slot rules, scenarios1–4/6–7 and rollout row. Geometry, authority, duplicate mapping, exact-window behavior and failures are explicit; no open human questions. Locked defaults accepted autonomously under LOOP.md. No separate tech.md or spec review under build-first.

2026-10-28 amendments: `ui.tool.open` is idempotent; clicking the selected stripe icon explicitly calls close. The removed editor activity-bar preference is not retained as an inert setting. Actual Tasks tool navigation/close stays in its resolved slot, Usage setup stays behind its existing status popover, and worktree pending-Ask counts derive from the public Ask API. These changes implement SC2/5/8 without introducing feature authority or an area restyle. Focused evidence and its limits are recorded in decisions D11–D14; suites, native acceptance and screenshot scoring remain unrun under build-first.
