import type { ReactNode } from 'react'
import type { Session } from '@quirky/protocol'
import { ControlIcon, FileIcon, ToolIcon } from '@quirky/ui'
import { paneLeaves } from '../../layout/tree'
import { isViewTab } from '../../layout/types'
import type { Tab } from '../../layout/types'

/** The session of a terminal tab's active pane, or its first pane when the active one is gone. */
export function leadSessionOf(tab: Tab, sessions: Readonly<Record<string, Session>>): Session | undefined {
  if (isViewTab(tab)) return undefined
  const leaves = paneLeaves(tab.root)
  const lead = leaves.find((leaf) => leaf.id === tab.activePane) ?? leaves[0]
  return lead ? sessions[lead.session] : undefined
}

/**
 * The mark drawn before a tab's title: the icon a view tab was opened with, or the terminal or agent
 * glyph for a terminal tab. A view tab with no icon draws nothing. A terminal tab counts as an agent
 * when its lead session runs anything but the shell.
 */
export function tabIconOf(tab: Tab, lead: Session | undefined): ReactNode {
  if (!isViewTab(tab)) {
    const agent = lead !== undefined && lead.agent !== 'shell'
    return agent ? <ToolIcon name="robot" hue="lilac" /> : <ToolIcon name="terminal-window" hue="cyan" />
  }
  const icon = tab.icon
  if (!icon) return null
  if (icon.kind === 'tool') return <ToolIcon name={icon.name} hue={icon.hue} />
  if (icon.kind === 'file') return <FileIcon path={icon.path} />
  return <ControlIcon name={icon.name} />
}
