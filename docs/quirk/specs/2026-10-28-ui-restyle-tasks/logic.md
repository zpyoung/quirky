# Tasks and Automations shared-system restyle

Status: Approved parent redesign; autonomous loop slice approved 2026-10-28.

## Purpose and conceptual model
Tasks and Automations remain daemon-owned tools in the host's left-bottom slot. Their issue/PR lists, Projects views, editors, settings and dialogs use the public graphite components and canonical tokens rather than plugin-owned styles. Existing commands, permissions, persisted selection, drafts and async generation fences remain unchanged.

## Key decisions & rationale
Use the existing @quirky/ui controls and centrally owned semantic feature layouts. Merely moving legacy CSS would preserve inconsistent spacing and controls; inventing a second component kit would break the approved system. Native semantic selects, checkboxes, textareas, tables and data-geometry surfaces remain appropriate where no shared component exists, with canonical shared classes and tokens. Do not replace feature state or RPC behavior during a presentation migration.

## Behavior and scenarios
- AC1: Opening Tasks from its stripe keeps the center work intact and shows its current mode in left-bottom. Issues/PRs retain search, filters, repo selection, selection actions and pagination. Example: switching Issues to PRs uses the existing navigate request and highlights PRs with the shared tabs.
- AC2: Issue details, comments, New Issue and workspace composer keep their existing validation, cancellation and daemon calls. Example: canceling an unsaved New Issue restores focus without sending create; title/body remain labeled and keyboard accessible.
- AC3: Projects retain table, board and roadmap data, field editing, grouping and view controls. Colors/spacing come from canonical tokens; actual timeline geometry remains derived from data, never rounded to decorative spacing. Example: selecting a board item opens the same canonical issue target.
- AC4: Automations retain list, search, status filtering, run history/results, editor, schedule controls and settings. Example: opening New Automation displays the existing draft in a shared dialog; Escape cancels through existing draft guard and does not create an automation.
- AC5: Settings, source/auth unavailable, loading, empty and failure states remain visible, labeled and actionable. Both themes use the same shared token names, with comfortable density and bounded narrow-panel overflow.
- AC6: No plugin style injection/private CSS/raw styling remains in either opted-in plugin. Both IDs are added to the existing enforced list; bun run typecheck includes UI lint and must pass.

## Scope and non-goals
Desktop visual migration only, including fallback sidebar mounts still registered for compatibility with existing public contributions. Default host slots stay unchanged. No daemon/API/schema/shortcut/business logic change, no phone UI, no new provider/network integration, no golden scoring or suite campaign during build-first mode. Existing behavior tests remain; add focused consumer-visible interaction coverage only where shared-control migration creates a plausible risk. No feature-doc-specific Orca defect is assigned to this visual-only item.

## Decisions locked
- Layout: host-owned left-bottom tools; no custom shell buttons or center-tab takeover.
- Density: shared comfortable rows, title/body/label tokens and canonical spacing/corners.
- State: existing loading/errors/empty action semantics and async freshness fences preserved.
- Interaction: labeled shared Buttons, TextFields, Tabs, Menus, Dialogs, FormRows, Badges, StatusDots and frames where applicable; native data controls use centrally styled semantic classes.
- Appearance: inherited dark/light graphite token set; no local palette or plugin stylesheet.

## Industry insights
Reuse approved parent research, particularly host-styled contribution points and Obsidian's CSS-variable/component guidance; no additional research swarm under authoritative LOOP build-first override. See ../2026-10-28-ui-redesign/logic.md#industry-insights.

## Deferred ideas
None. Screenshot scoring, full suites and full dogfood are deliberately unrun workflow stages under build-first, not new backlog items.

## Glossary
Tool: host-mounted slot panel. Shared semantic layout: feature presentation CSS owned and linted by packages/ui, not an injected plugin style string.

## Technical decisions and contracts
- Public @quirky/ui exports and existing components are the contract; add workspace dependencies to both plugin package manifests before dispatch. No new public types or API signatures required.
- Three independent components: Tasks list/composer; Tasks issue/Projects; all Automations UI. Main integration owns Tasks ui.tsx/settings/sidebar, package/lock integration, lint list and shared CSS imports.
- Owned canonical layouts: packages/ui/src/design-system/tasks-list.css, tasks-detail.css, automations.css; parent tasks-shell.css. All values use existing semantic or compatibility tokens; no arbitrary raw-value additions to tokens. No export/API changes without parent approval.
- Workers never edit shared styles.css/index/contracts/tokens, package manifests, lockfile, lint list or loop metadata. All workers use absolute isolated worktree paths, do not stage/commit or run tests/build/lint/formatters. Parent audits at the all-worker barrier, then integrates and runs typecheck once.
- Acceptance gate: bun run typecheck. Focused actual built-UI smoke on an isolated private profile exercises changed surfaces and both themes; this is not a suite or golden review. New authored regression tests remain unrun until end phase.

## Status & amendments
Self-review: all assigned visual surfaces map to AC1–6; no API/state migration, unresolved decision or placeholder. Parent approved design remains authoritative.

Amendments: none.
