# Worktrees and repository management restyle

Status: Approved parent design; autonomous slice decisions recorded under LOOP.md.

Reader: the area implementer and final UI reviewer — decide whether the existing Worktrees and repository-management surfaces conform without changing feature behavior.

## Purpose and conceptual model

Restyle the existing Worktrees tool and every repository/worktree dialog it owns using the public `@quirky/ui` components and semantic graphite tokens. The host continues to own the tool frame and its existing left-top default slot. `quirky.repo` has no renderer contribution: its project operations remain exposed inside the Worktrees tool and through its existing public API/CLI.

## Scope and non-goals

All rendered descendants of `WorktreesSection` are in scope: tree rows, group/project headers, context menus, board, orchestration/automation details, filters/options, external-worktree inbox, notices, create/edit/delete/cleanup/group/project dialogs and embedded project settings. Opt both named plugins into canonical UI lint.

No daemon schema, feature API, CLI, keyboard-shortcut, persisted feature behavior, phone UI, host layout authority, or native picker behavior changes. No additional repository tool or plugin stylesheet. Existing custom project/status identity data remains editable and stored; decorative display uses shared semantic colors, not arbitrary theme-breaking paint. Feature names, emoji/icon identity and status labels remain readable.

## Behavior and scenarios

All criteria must hold:

1. **Default tool and tree.** Given a project with a primary checkout, child worktree and selected worktree, opening Quirky shows Worktrees in its existing slot. Group/project collapse, primary badge, nesting, drag/reorder, selection and contextual actions remain functional. Example: selecting `fix-desktop` changes the canonical active worktree, not the tools layout.
2. **Name plus activity.** Every visible worktree has a readable name and secondary activity line. Real session state supplies one session identity (its title, falling back to agent or kind) plus activity; do not repeat internal agent/kind metadata alongside the title. Preserve custom titles and the configured branch display. A worktree without an active agent says Idle or its actual pending/deleting/sleeping state. Working/needs-you/failing/done/idle map to shared status semantics. A pending Ask retains the amber count and does not steal selection. Example: `provider-host` with one pending question shows count 1 while another worktree stays selected; answering removes its count.
3. **Repository flows.** Add project, clone/create/import/folder flows, group management, project settings and remove-project confirmation retain their existing API calls, cancellation, terminal/Ledger warnings and trust boundaries. Example: canceling Remove project leaves registration and disk unchanged.
4. **Worktree flows.** Create from existing supported sources, setup/issue trust choices, Create more, base fallback, update notes/status/parent, cleanup and deletion retain all safety and navigation semantics. Example: canceling Delete leaves the worktree; confirming retains the existing dirty-worktree warning and public removal path.
5. **Secondary controls.** Existing filters/sorts/grouping/reveal, board, statuses, activity, external worktrees and embedded provenance/agent details remain reachable through shared controls; low-frequency options may collapse within the panel without removing features.
6. **States and themes.** Shared empty, loading, error, disabled and form states are legible in both pinned themes. No local CSS, raw colors or pixel literals remain in enforced plugin source. Example: no repositories shows a shared empty state and Add project action, not an empty inaccessible panel.
7. **Shared component interaction.** Dialogs preserve stacked Escape behavior, focus containment/restoration and existing submit/cancel paths. Context menus preserve pointer position, disabled primary deletion and all submenu actions. Layout measurement/runtime coordinates remain runtime data, not hardcoded pixel styling.

## Key decisions and alternatives

Recommended: migrate in place with existing component APIs and a small reusable shared-layout vocabulary where necessary. CSS-only repaint would leave bespoke controls and drift; a new repo tool would duplicate authority and change behavior. Keep the host frame rather than nest a second titled ToolPanelFrame inside it.

Layout uses comfortable two-line list rows; optional metadata and action controls remain available. Narrowing the Worktrees panel to 160px or the window to 646px keeps the same row height: idle reveal controls do not reserve a blank action line, and hover or keyboard focus exposes the menu without increasing row height. At effective panel widths of 160px or less, the Primary badge yields to the menu; attention counts remain visible. Low-frequency panel options collapse under shared controls to avoid obscuring the tree. Loading/error remain explicit; failures are never hidden as empty data. Existing user-selected status/project colors stay data but presentation uses tokens under the approved palette. Identity labels and editable values remain available.

## Decisions locked

- Approved parent design and existing shell/tool IDs/default placement remain authoritative.
- Preserve feature state and API callbacks; migrate presentation only.
- Use public shared components, shared layout classes and semantic tokens; no plugin-owned CSS or private UI imports.
- Add both `quirky.worktree` and `quirky.repo` to the staged lint registry.
- Build-first execution: one combined spec; no research swarm, formal review or suites. Typecheck includes canonical UI lint. Minimum real-surface smoke is recorded separately from automated screenshot approval.

## Industry insights

Reuse the approved parent spec's researched design-system rationale and goldens; no additional external research under build-first. See `../2026-10-28-ui-redesign/logic.md#industry-insights`.

## Deferred ideas

None. Full screenshot-model sign-off remains the existing final visual-review workflow, not a new product flow or a claimed pass from capture-only evidence.

## Glossary

Tool: host-mounted contribution in one saved slot. Activity: actual agent/session state or explicit idle/lifecycle state. Repository management: worktree-rendered project operations owned by `quirky.repo` APIs.

## Status & amendments

2026-10-28: autonomous approval of this bounded slice under LOOP.md; parent design unchanged.

2026-10-28 composition amendment: the sole roadmap catch-up delivered the richer canonical ContextMenu from ui-restyle-terminal. Reuse it directly and remove this branch's redundant Menu extension/adapter/styles/tests. Add only the meaningful disabled-action tooltip and viewport clamp to that shared owner; ordinary dropdown Menu remains unchanged.

## Technical decisions and implementation contracts

### Architecture and shared contracts

The existing `sidebar-section:quirky.worktree/worktrees` remains the only mount. All public method signatures and persisted types are unchanged. Existing public `Button`, `IconButton`, `TextField`, `FormRow`, `Tabs`, `ListRow`, `SectionHeader`, `Badge`, `StatusDot`, `Menu`, `Dialog`, `EmptyState`, `InlineAgentCard` and their contracts in `packages/ui/src/design-system/contracts.ts` are the implementation authority. Native select/textarea/checkbox controls may be composed with FormRow and shared control classes. Generic layout uses `ui-stack`, `ui-cluster`, `ui-text-muted`; necessary reusable additions belong in the shared design system, not a plugin stylesheet. Measured coordinates, depth and percentages remain runtime custom-property data.

DO NOT CHANGE: daemon/API/CLI files, feature algorithms/hooks/state authorities, plugin manifest contribution IDs, real user homes or protected loop scripts. Preserve stable data-worktree-id/instance identity, controller/report behavior and every existing destructive/trust callback. No fake agent data or hardcoded working state.

2026-10-28 shared presentation extensions, committed before use:

- Reuse canonical `ContextMenu`/`ContextMenuList` and `ContextMenuItem` from `@quirky/ui`, including existing nested keyboard/search semantics. Worktree feature builders produce that type directly. `ContextMenuItem.title` preserves disabled-action reasons and shared ContextMenu clamps its measured root on size/window changes. No local context component or parallel Menu variant remains.
- `ListRow` adds `mainTitle`, `mainLabel`, optional `progress` and `compact`; its existing single shared dot renders progress and compact rows retain their activity description. `StatusDot` accepts finite percentage progress with 0–100 clamping.
- `SectionHeader` accepts standard header attributes plus `titleTooltip`, preserving context/drop targets and true hidden state.
- `Dialog` gains `size: default|wide`; shared top-dialog focus ownership replaces the local wrapper. Remove the obsolete plugin Dialog implementation and import the shared component directly.
- Parent removes obsolete worktree-only rules in `packages/ui/src/styles.css`; semantic/data hooks may remain but no longer depend on plugin-specific CSS.

### Ownership and wave

One wave, three independent components, no semantic dependency or scope overlap. OpenAI task implementers; parent owns shared stylesheet/layout additions and integration. No cross-family backend is probed because build-first prohibits review rounds. Parent leaves inherited `.serena/` untouched.

- Tree slice: `Tree.tsx`, `Menu.tsx`, `StatusDot.tsx`, `LoopGlyph.tsx`, `WorktreeBoard.tsx`, `OrchestrationRows.tsx` under `plugins/quirky.worktree/src/`.
- Dialog slice: all existing `*Dialog.tsx`, `GroupDialogs.tsx`, and `Dialog.tsx` under that same directory. No files in the tree or panel slices.
- Panel slice: `WorktreesSection.tsx`, `StockOptions.tsx`, `ActivityFilters.tsx`, `ExternalInbox.tsx`, `Notices.tsx`, `ledger.tsx`, `ui.tsx` under that directory.
- Parent: `packages/ui/src/design-system/components.css`, any necessary shared presentation contracts/implementation, lint plugin registry, README/decision/spec documentation and regression coverage only where a consumer-visible edge changes.

Workers use existing signatures; shared extension requests return to the parent. Each worker runs no checks, builds, formatters or commits. Parent audits scopes at the all-worker barrier, integrates, then runs `bun run typecheck`, `bun packages/ui/build.ts` and isolated changed-surface browser smoke. The existing filtered capture command is `bun run ui:review -- --author-family openai --output <fresh-absolute-directory> --only quirky.worktree --capture-only`; not-reviewed is never called screenshot approval. Full independent model scoring is skipped by the item-specific build-first override.

### Coverage

Existing worktree API/CLI and renderer behavior coverage remains unchanged unless component semantics require a boundary regression. Do not add source-text, copied-style, mock-forwarding or wording tests. Focus smoke on real default placement, rows/activity, menus, repository settings, create/update/cancel and both themes with a fresh isolated HOME/QUIRKY_HOME and owned process cleanup. Platform execution is macOS only; no native or cross-platform proof is inferred.
