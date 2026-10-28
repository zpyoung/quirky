# Agent and session surfaces on the graphite system

Status: Approved autonomous execution of the approved [desktop redesign](../2026-10-28-ui-redesign/logic.md), 2026-10-28. One combined logic/technical spec under build-first.

## Goal and conceptual model

Restyle quirky.agents, quirky.agent-status, quirky.session and quirky.session-info using the public shared components and semantic tokens. Keep existing daemon authority, public API/CLI, provider status vocabulary, permissions, session lifecycle and contribution IDs. The host still owns chrome and slots; feature content remains inside its registered surface.

Agents configuration, Activity, Dashboard, session/worktree/structured content, History and Transcript remain center views. Session info remains the existing right-bottom tool. Agent-status sidebar contributions remain registered tools through the shell's projection, not new plugin chrome. No duplicate navigation or new feature registration.

## Key decisions and rationale

- Compose existing @quirky/ui controls, rows, sections, agent cards, panels, empty states and dialogs. Use --ui-* tokens for necessary feature layout, wrapping, scrolling and terminal geometry. Native textarea/select/checkbox controls remain within shared FormRow where a matching shared control is unavailable; their styling uses existing shared classes/tokens. No local CSS, raw colors or fixed pixel styles.
- Keep information density comfortable and hierarchy quiet: graphite surfaces, muted secondary text, indigo selection; green working, amber needs-user, red failures, indigo done, gray idle/queued. Detailed status labels and progress/unread information are preserved, not collapsed into an incorrect state.
- Preserve loading, error, stale, unavailable, empty and retry behavior. Missing usage is not zero. Long paths, commands and diagnostics wrap; action groups wrap and panels scroll rather than clipping at narrow sizes.
- CSS-only repaint of legacy controls was rejected: it preserves competing local component conventions. Rebuilding feature state or registration was rejected: the approved redesign forbids behavior changes.

## Behavior and acceptance scenarios

SC1. Agents configuration: given existing providers/default/permissions/trust, opening Agents shows shared section and form hierarchy. Choosing a default, permission or enabled state and saving/resetting command/arguments/environment use the existing store/API. Installed/available groups, docs/install links, refresh, errors and custom-argument replacement remain available. Example: expand an installed agent, edit its command, Save, then Reset; the authoritative command follows those operations.

SC2. Activity and Dashboard: existing grouped/session status data, filters, worktree navigation, read/clear controls, visibility/settings and dashboard launch/send/stop behavior retain their original semantics. Shared status dots/cards use the approved meanings while retaining exact detailed labels. Example: a waiting session remains amber and actionable after a filter change; filtering never changes its daemon status.

SC3. Session views: worktree/session selection, tabs, menus, prompt/rename/close confirmations, exited controls and structured-message/event/composer interactions remain intact. Terminal content stays mounted through tool focus and keeps the canonical theme adapter. Shared dialog/menu/tab/empty/form presentation replaces plugin-local controls. Example: type a draft, focus Session info, return to the session; draft/session selection remain intact.

SC4. Session info: opening the right-bottom tool follows canonical terminal focus. Identity, Usage, Live activity, Context, Files touched and Hooks & MCP retain daemon-persisted accordion state; copy/history/vault/focus/transcript/reveal, stale usage retry and telemetry consent actions retain their APIs and feedback. Example: expand Identity in a narrow slot; long IDs wrap and all actions remain reachable by vertical scrolling. No session shows an honest shared empty state.

SC5. History and Transcript: existing search/resume/copy/open/reveal and transcript retry preserve behavior and show shared field/row/button/error/empty hierarchy. Example: a search with no matching sessions shows the empty result, not an invented record; clearing it restores actual results.

SC6. Both themes: all these surfaces follow the root appearance immediately with semantic token colors and no raw CSS fallback. Selected controls, muted text, errors and status meanings remain legible. Existing registered slots, exact-window routing and scripting contracts remain unchanged.

SC7. Enforcement: all four IDs are added to scripts/ui-lint-plugins.json, preserving concurrent additions. bun run typecheck invokes UI lint and must reject raw colors/pixels or plugin CSS for these sources. No lint suppression/baseline or weakening of the scanner.

## Defect coverage

Preserve behavioral coverage for command-save validation, permission custom-argument replacement, status ownership/freshness, exact-window session focus, unread/progress cues, structured drafts, narrow wrapping/action reachability, persisted accordion selection, stale usage recovery, missing provider telemetry and copy feedback. Existing source-text, incidental class/style, enum-copy and forwarding-only assertions must be removed rather than repinned. Author any necessary behavioral regression coverage but do not execute suites under build-first.

## Scope and non-goals

All UI-owned source in the four plugins is in scope, including menus/dialogs/settings/sidebars/views. Backend status reducers, provider config/installers, session state/PTY runtime, generated API schemas and CLI are unchanged. No phone restyle, new provider behavior, hooks installation, global config access, native-window action, shortcut changes, screenshot RPC, new tool registry or new feature. Native clipboard/Finder/notifications retain their existing owners and pending scenarios.

## Technical decisions and contracts

Public shared interfaces already exist in packages/ui/src/design-system/contracts.ts and are not changed. Button accepts native button props and variant primary/secondary/destructive; IconButton requires label; TextField requires label; ListRow supplies title/description/status/count/trailing/selection; SectionHeader title/actions; Tabs label/items/value/onChange; Menu label/items; Dialog open/title/children/actions/onClose; FormRow label/htmlFor/help/error/children; ToolPanelFrame title/actions/children; InlineAgentCard title/description/status/action. UiStatus is working | needs-you | failing | done | idle | queued. Existing detailed display states map only at the presentation boundary. No public API/schema/type addition is needed or invented.

Shared signatures and this immutable reuse contract are committed before dispatch. Parent owns scripts/ui-lint-plugins.json, item docs, integration/typecheck and smoke. Three disjoint components, no dependencies: A owns plugins/quirky.agents/src/window/** and plugins/quirky.session/src/window/** plus their UI entrypoints and UI test files; B owns plugins/quirky.agent-status UI presentation modules and UI tests; C owns plugins/quirky.session-info/src/window/**, UI entrypoint and UI tests. Workers may remove obsolete local presentation files; no backend/generated manifests or shared UI source writes without parent-approved scope change. Workers never run checks/build/lint/tests/formatters or commit. Separate external worktrees, one barrier, exact changed-path attribution before commit/merge; parent preserves inherited .quirk/.serena.

Acceptance gate: bun run typecheck. Parent builds the actual renderer and exercises changed surfaces in a fresh fully isolated HOME/QUIRKY_HOME with owned daemon/browser cleanup. The repository ui:review command can capture selected exact plugin IDs in both themes; captures are not approval unless independent threshold-85 scoring passes. Build-first forbids a formal review/dogfood campaign: any narrow runtime evidence and visual limits are reported honestly. Catch up once with git merge build/roadmap immediately before final typecheck and canonical queue land. No tests or review-only follow-up items.

## Industry Insights

Reuse the approved parent specification's Linear/PyCharm/Zed/VSCode research and the shipped shared component contracts. No research swarm under build-first.

## Decisions Locked

Existing approved tokens, 15 shared component categories, six tool-slot ownership, dark/light behavior and no feature/shortcut changes. Existing agent/session authoritative data and action APIs remain binding. Autonomous standard gray areas resolve to existing layouts/actions with shared presentation; no human asks.

## Deferred Ideas

None. Screenshot campaign and full-suite execution retain their existing end-phase owners; no product flow is deferred.

## Glossary

Tool: host-framed contribution in a persistent slot. View: registered center-tab contribution. Semantic status: shared visual category, not a replacement daemon state. Capture: evidence of rendered pixels, not an automatic passing review.

## Self-review and amendments

2026-10-28: checked scope against the four plugins, parent rollout row, shared contracts and shell mount/focus invariant. Every named UI surface and error/empty/interaction state is assigned. No unresolved questions, invented API or changed feature semantics. LOOP autonomous approval replaces the human review gate; separate tech.md/spec review omitted under build-first.

2026-10-28 amendment: Session Info uses the host's existing shared tool frame rather than nesting a second ToolPanelFrame/title; its content still composes shared rows, buttons and sections. Full accordion-title activation and short visible Activity/Dashboard Open actions preserve usable targets without exposing internal IDs. The terminal plugin normally overrides the session worktree contribution; the disposable disabled-terminal smoke explicitly exercises the genuine fallback. Current-source visual proof and its earlier-capture/native/provider/scoring limits are recorded in item decisions D10–D12.
