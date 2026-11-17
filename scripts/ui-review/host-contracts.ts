import type { CaptureTarget, CaptureTheme, HostContractContext, ContractRule } from './contracts'

type ThemeValues = {
  surface: string
  rail: string
  selected: string
  accent: string
  border: string
  text: string
  muted: string
}

const THEME_VALUES: Record<CaptureTheme, ThemeValues> = {
  dark: {
    surface: '#16171b',
    rail: '#0c0d0f',
    selected: '#22242b',
    accent: '#7c8cff',
    border: '#24262c',
    text: '#eceef2',
    muted: '#7c828d'
  },
  light: {
    surface: '#ffffff',
    rail: '#eef0f3',
    selected: '#e7e9ef',
    accent: '#5b6cff',
    border: '#e3e5ea',
    text: '#1b1d22',
    muted: '#80868f'
  }
}

const RULE_SOURCES = {
  'host-frame-ownership': 'scripts/ui-review/capture.ts (full-window capture composition); g3-67 spec Section 2, scenario 1; docs/quirk/specs/2026-10-30-ui-pycharm-shell/logic.md, Frame and cards',
  'host-underline-tabs': 'g3-62 scenarios 1 and 8; packages/ui/src/design-system/components.css (tool-panel header tabs); docs/quirk/specs/2026-11-05-worktrees-plugin-redesign/logic.md (saved-view tabs)',
  'palette-retained-spacing': 'g3-62 scenario 12',
  'palette-selected-colors': 'g3-62 scenario 7',
  'worktrees-approved-redesign': 'docs/quirk/specs/2026-11-05-worktrees-plugin-redesign/logic.md, Design direction and SC-2 through SC-4; docs/quirk/specs/2026-10-28-m6-orchestration-ui/logic.md AC7 (orchestration rows)'
} as const

function compareRuleIds(left: ContractRule, right: ContractRule): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/** Returns repository-owned rules for a rendered full-window capture; titles never become instructions. */
export function hostContractContext(target: CaptureTarget, theme: CaptureTheme): HostContractContext {
  const colors = THEME_VALUES[theme]
  const rules: ContractRule[] = [
    {
      id: 'host-frame-ownership',
      source: RULE_SOURCES['host-frame-ownership'],
      text: `Applies to every full-window capture. Distinguish the named contribution from surrounding shell chrome. Theme token values for ${theme}: --ui-surface: ${colors.surface}; --ui-rail: ${colors.rail}; --ui-selected: ${colors.selected}; --ui-accent: ${colors.accent}; --ui-border: ${colors.border}; --ui-text: ${colors.text}; --ui-muted: ${colors.muted}. These hex values are checked-in token defaults; use the resolved --ui-text and --ui-muted foreground tokens, not a blanket fixed runtime foreground requirement. In light mode a white content surface is valid; the rail and gaps use the separate rail token. The approved host frame has these values. Open tool cards and the main card sit on the workspace rail with a 5px rail-colored gap between neighbors, side by side and stacked. Every card has a 10px corner radius, and its corner cutouts show the rail. Cards meet the title bar and status bar flush, with no extra outer inset, because both bars use the rail color. In ${theme} the rail is ${colors.rail} and card surfaces are ${colors.surface}, so each gap is a low-contrast ${colors.rail} strip between ${colors.surface} cards. The shell golden shows this same frame, with the same 5px gap, 10px radius and flush edges. A 5px gap, a 10px radius and flush outer edges are not defects. A request for wider or thicker gaps, card borders or shadows, or an outer inset contradicts this contract. Panels that actually touch with no rail strip, square or clipped corners, and a gap in the wrong color remain host defects. Missing actual host gaps or corners remain host defects and must not be described as a defect in a plugin's row stylesheet. Do not waive a genuinely all-white frame or touching panels. Legitimate content differences and the documented offline absence of hosted Checks data do not authorize inventing or removing product controls.`
    },
    {
      id: 'host-underline-tabs',
      source: RULE_SOURCES['host-underline-tabs'],
      text: "Four tab treatments are approved; judge each tablist against its own. Open views and palette Search scope: the tablist is ui-tabs ui-tabs--underline, with a 1px solid var(--ui-border) bottom rule. Selected tabs have no top border, zero radius, var(--ui-surface) background, var(--ui-text) foreground, and an inset 2px bottom accent underline. Unselected tabs are transparent, have no top border or shadow, and use var(--ui-muted). An underline is not a defect merely because it differs from the older golden. ToolPanelFrame header tabs, beside a tool panel's title such as Tasks (Issues, PRs, Projects) and Agent Session History (Workspace, Project, All): the tablist has no bottom rule and wraps whole tabs onto another row when narrow; tabs are compact, with 2px by 4px padding, a 7px radius, a transparent background and a transparent 1px border, and use var(--ui-muted); the selected tab keeps a transparent background with a 1px var(--ui-accent) border and var(--ui-text). They are neither boxed nor underline tabs, and this compact look is not a defect. Worktrees saved-view tabs (All, Needs you and starred views): a single scrolling row with no tablist bottom rule; tabs are transparent and borderless in var(--ui-muted), and the selected tab uses var(--ui-text) with a 2px var(--ui-accent) bottom border. They are neither boxed nor the Open views underline tablist. Other standalone Tabs, such as those in dialogs and settings, keep their existing boxed default: a 1px var(--ui-border) border, rounded top corners, and var(--ui-selected) behind the selected tab. A tablist that matches its own treatment is not a defect for lacking another treatment's border, underline or box. Clipped or partial labels, unreadable text, a missing selected state and overlap remain defects."
    },
    {
      id: 'palette-retained-spacing',
      source: RULE_SOURCES['palette-retained-spacing'],
      text: 'The palette list padding is 8px on every side and selected row block padding is 8px with no border. These retained values are not adjustable score-tuning knobs. This rule does not excuse bad text alignment or wrapping.'
    },
    {
      id: 'palette-selected-colors',
      source: RULE_SOURCES['palette-selected-colors'],
      text: 'Palette results have a transparent list background, no list border, and a maximum height of 60vh (528 CSS px at the 880px capture viewport). A selected row is accent with rail-colored text; its description inherits that exact text color, including on hover. Asking for a different selected description shade contradicts the contract. Actual wrong colors, unreadability, or clipping remain defects.'
    },
    {
      id: 'worktrees-approved-redesign',
      source: RULE_SOURCES['worktrees-approved-redesign'],
      text: 'The approved Worktrees redesign supersedes the older shell golden for this component. Worktree checkout rows (activity mark, worktree name, up to two tag chips plus +N, and one right-side fact) are single-line 26px, with 4px gaps and 12px indentation; selection is neutral var(--ui-selected) with a bold name, not blue. Saved-view tabs, filter and changed lines, header actions, hierarchy, counts, and rail attention badges are approved capabilities. Their presence or one-line density is not a defect. Orchestration session rows nested under a worktree are not checkout rows: coordinator rows (Coordinator followed by a session name, Orphaned coordinator, Coordinator unavailable) and worker rows (a task name, or Worker assignment unverified) are shared list rows with a title line above a muted status description at a 34px minimum, and at narrow widths they wrap their full text onto further lines instead of clipping it. That second line, the 34px height and that wrapping are not defects, and the single-line 26px checkout anatomy does not apply to them. Overflow that clips or overlaps text, illegible names, missing controls, and incorrect implementation of these rules remain defects in either kind of row. This rule does not apply Worktrees row anatomy to Remote workspaces.'
    }
  ].sort(compareRuleIds)

  return { schemaVersion: 1, targetId: target.id, theme, rules }
}

/** Serializes only the contract shape, with stable field and rule ordering for digesting. */
export function serializeContractContext(context: HostContractContext): string {
  const rules = [...context.rules].sort(compareRuleIds).map(({ id, source, text }) => ({ id, source, text }))
  return JSON.stringify({
    schemaVersion: context.schemaVersion,
    targetId: context.targetId,
    theme: context.theme,
    rules
  })
}
