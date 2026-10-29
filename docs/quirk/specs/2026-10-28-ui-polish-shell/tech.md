# Shell polish implementation contracts

**Status:** Ready for autonomous review, 2026-10-28.
Logic: [logic.md](logic.md). Tier: crosses host/plugin boundary and at least three source files.

## Architecture

[Behavior](logic.md#behavior--scenarios): retain existing ToolShell → ToolPanelFrame → PluginSlot → independently mounted WorktreesSection architecture. Use shared `ToolPanelActions` to portal plugin controls into the nearest shared frame's dedicated header action target. A marker rendered in the plugin root identifies the nearest enclosing frame after commit; React context alone cannot cross the separately mounted plugin root. No global query, singleton selected panel, plugin-specific host branch or protocol change.

## Code references

Paths relative to the repository root `/Users/zpyoung/orca/workspaces/quirky/build-lane-12` (implementer worktrees have identical relative paths):
- `packages/ui/src/design-system/panels.tsx`: ToolPanelFrame at line68; shared ToolPanelActions to add.
- `packages/ui/src/design-system/contracts.ts`: ToolPanelFrameProps line40; add ToolPanelActionsProps containing children only.
- `packages/ui/src/design-system/index.ts`: public component/type exports.
- `plugins/quirky.worktree/src/WorktreesSection.tsx`: line511 onward composes toolbar, StockOptions, ActivityFilters and More workspace tools. Move this existing control cluster to Popover anchored by IconButton portaled using ToolPanelActions. Keep callbacks and existing dialogs.
- `plugins/quirky.worktree/src/Tree.tsx`: Primary Badge accent → neutral.
- `packages/ui/src/shell/ToolShell.tsx`: ToolMenu/ToolItem/ToolStripe lines307–575 create separate tiny move triggers and maintain continuous viewport positions. Replace this obsolete trigger/position machinery with one ContextMenu opened by contextmenu or Shift+F10/ContextMenu key on the real icon, preserving six destination actions and current-slot refusal.
- `packages/ui/src/shell/tool-shell.css`: remove obsolete menu-trigger/portal styles only; existing shared ContextMenu handles its own viewport geometry.
- `packages/ui/src/design-system/floating.tsx`: reuse existing Popover unchanged unless an exercised defect requires a scoped repair.
- Consumer tests `plugins/quirky.worktree/test/ui.test.ts`, `plugins/quirky.worktree/test/sidebar-extras-ui.test.ts`; shared tests `packages/ui/test/design-system.test.tsx`; shell behavior test may be added in `packages/ui/test/tool-shell-menu.test.tsx`.

## Contracts & interfaces

[Decisions](logic.md#decisions-locked): ToolPanelActions accepts React children and renders them ONLY into its nearest ToolPanelFrame's dedicated header action target. Frame always supplies that target, including when no static actions/minimize callback exists. Independent frames and independent plugin React roots cannot steal one another's actions. On unmount, portal content is removed. No fallback toolbar or duplicate title. Standalone tests must mount within a real ToolPanelFrame so they exercise the production boundary. Frame's existing actions/onMinimize remain supported unchanged.

Options trigger: accessible name `Worktrees options`, aria-expanded and aria-haspopup=dialog, filter/options icon, no text toolbar. Popover label `Worktrees options`. Close before opening separate dialogs where needed to preserve existing dialog focus and Escape behavior. Use existing StockOptions and ActivityFilters disclosures inside the popover; the request hides controls behind one outer affordance, not rewrites their internals. Applied filters survive dismissal/reopen.

Stripe: tool icon preserves title, aria-pressed, click toggle and draggable data contract. Right click and Shift+F10/ContextMenu open shared ContextMenu at the icon/pointer; six existing layout destinations and disabled current destination; dismissal returns focus to the invoking icon when appropriate. No second visible stripe button, hidden chevron or alternate generic Menu default.

## Data models / schemas

[Data](logic.md#data-flow): no persisted, daemon, protocol, CLI or registration-ID changes. ToolPanelActionsProps has only children: ReactNode. Local options/context-menu visibility and invoking element references are ephemeral.

## DO-NOT-CHANGE fences

[Scope](logic.md#scope-and-non-goals): preserve all workspace preference mutations, selected-row filtering exceptions, current operation dialogs/trust/deletion semantics, Worktrees slot/ID and host layout API. Do not change generic Menu trigger defaults, approved goldens, historical before screenshots, protected loop scripts/instructions, queue.json or DECISIONS.md. Preserve unrelated .serena metadata.

## Always / Ask / Never

Always use existing shared IconButton/Popover/ContextMenu/Badge and tokens. All autonomous choices recorded in item decision log; never ask a person. Never add local plugin CSS/raw color/pixel/lint exemptions, timers/retries or a second state owner.

## Cross-cutting

[Evidence](logic.md#s4-primary-identity-and-themes): macOS-only isolated HOME/QUIRKY_HOME and owned browser/processes. No real provider credentials or profile. Refresh only after/shell pair, their manifest bytes/source revision and index provenance. All other gallery sources stay attributed to their original commits. No native behavior changed; no native-certification claim.

## Testing strategy

[Scenarios](logic.md#behavior--scenarios): adjust existing test access to go through header options/portal; preserve behavioral assertions. Add consumer-visible closed/open/dismiss/reopen-filter coverage, and separate-root/independent-frame action lifecycle coverage. Add shell click/context-menu keyboard/move tests if existing suite lacks them. Do not add source-string, class-name, incidental copy or forwarding-only tests.

Parent verification commands: `bun scripts/suite.ts packages/ui plugins/quirky.worktree`; `bun test scripts`; `bun run typecheck`; `bun packages/ui/build.ts`. UI proof uses fresh real daemon fixtures, actual renderer opening/dismissing options, filtering/clearing, Add project cancel, stripe context move and plain both-theme screenshots. Capture command: `bun run ui:review -- --author-family openai --only host:shell --capture-only --output /tmp/quirky-shell-l12-captures` (a fresh output directory). Capture-only is not model approval. Compare actual screenshots to approved goldens. Worker writes tests but skips all checks; parent runs once after integration.

## Non-goals

See [logic scope](logic.md#scope-and-non-goals). No registry migration or new feature API. No unrelated restyle or exhaustive gallery recapture.
