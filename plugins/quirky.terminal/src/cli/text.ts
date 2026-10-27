import { displayTitle } from '../layout/titles'
import type { FloatingState, GroupNode, PaneNode, QuickCommand, Tab, Workspace } from '../layout/types'

const indent = (depth: number) => '  '.repeat(depth)

function paneLines(node: PaneNode, depth: number, activePane: string | null, lines: string[]): void {
  if (node.kind === 'split') {
    lines.push(`${indent(depth)}split ${node.direction} ${node.ratio}`)
    paneLines(node.first, depth + 1, activePane, lines)
    paneLines(node.second, depth + 1, activePane, lines)
    return
  }
  const exit = node.exit ? ` exit ${node.exit.code ?? node.exit.signal ?? '?'}` : ''
  lines.push(`${indent(depth)}pane ${node.id} ${node.session}${exit}${node.id === activePane ? ' (active)' : ''}`)
}

function tabLines(tab: Tab, depth: number, active: boolean, lines: string[]): void {
  const color = tab.color === 'none' ? '' : ` ${tab.color}`
  lines.push(`${indent(depth)}tab ${tab.id} ${JSON.stringify(displayTitle(tab))}${color}${active ? ' (active)' : ''}`)
  paneLines(tab.root, depth + 1, active ? tab.activePane : null, lines)
}

function groupLines(node: GroupNode, depth: number, activeGroup: string, lines: string[]): void {
  if (node.kind === 'split') {
    lines.push(`${indent(depth)}split ${node.direction} ${node.ratio}`)
    groupLines(node.first, depth + 1, activeGroup, lines)
    groupLines(node.second, depth + 1, activeGroup, lines)
    return
  }
  const focused = node.id === activeGroup
  lines.push(`${indent(depth)}group ${node.id}${focused ? ' (active)' : ''}`)
  for (const tab of node.tabs) tabLines(tab, depth + 1, focused && node.activeTab === tab.id, lines)
}

/**
 * The indented tree `quirky terminal layout` prints: one line per split, group, tab and pane, two
 * spaces per depth. `(active)` marks only the focus path: the active group, its active tab and
 * that tab's active pane.
 */
export function renderWorkspace(workspace: Workspace): string {
  const lines: string[] = []
  groupLines(workspace.root, 0, workspace.activeGroup, lines)
  return lines.join('\n')
}

/** One line per quick command, as the columns `quick-command list` prints. */
export function quickCommandRows(commands: readonly QuickCommand[]): string[][] {
  return commands.map((c) => [c.id, c.label, c.kind, c.scope, c.command.trim().split(/\s*\r?\n\s*/).filter(Boolean).join('; ')])
}

/** The floating workspace's state as the key/value pairs `floating state` prints. */
export function floatingPairs(state: FloatingState): [string, string][] {
  const { bounds, button } = state
  return [
    ['enabled', String(state.enabled)],
    ['open', String(state.open)],
    ['maximized', String(state.maximized)],
    ['bounds', bounds ? `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}` : 'default'],
    ['button', button ? `${button.x},${button.y}` : 'default']
  ]
}
