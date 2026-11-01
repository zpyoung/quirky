import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Group, Tab } from '../../src/layout/types'
import { PlayIcon } from '../../src/window/quick-commands/shared'
import { GroupTree } from '../../src/window/workspace/GroupView'

/** Mounts the real tab strip in a browser page, driven by `window.stripControls`, with no daemon or panes. */
export type StripFixture = { tabs: string[]; active: string }
export type StripControls = { activate(id: string): void; close(id: string): void }

const CREATED_AT = '2026-10-29T00:00:00.000Z'

const terminalTab = (id: string): Tab => ({
  id,
  defaultTitle: id,
  customTitle: null,
  liveTitle: null,
  color: 'none',
  pinned: false,
  root: { kind: 'pane', id: `pane-${id}`, session: `session-${id}`, title: null, exit: null },
  activePane: `pane-${id}`,
  expandedPane: null,
  createdAt: CREATED_AT,
})

const stripExtras = () => (
  <div className="qc-strip">
    <button type="button" className="ui-button ui-button--secondary qc-single">
      <span className="ui-icon-button__icon"><PlayIcon size={13} /></span>
      <span className="qc-run-label">Command</span>
    </button>
  </div>
)

function Strip({ fixture }: { fixture: StripFixture }) {
  const [tabs, setTabs] = useState(() => fixture.tabs.map(terminalTab))
  const [activeTab, setActiveTab] = useState(fixture.active)
  const controls: StripControls = {
    activate: setActiveTab,
    close: (id) => setTabs((current) => current.filter((entry) => entry.id !== id)),
  }
  Object.assign(window, { stripControls: controls })
  const group: Group = { kind: 'group', id: 'grp-1', tabs, activeTab, recent: [], lastQuickCommand: null }
  const controller = new Proxy<Record<string, unknown>>(
    { options: { stripExtras }, activateTab: async (id: string) => setActiveTab(id) },
    { get: (target, name: string) => target[name] ?? (() => {}) },
  )
  const state = {
    workspace: { id: 'wt', revision: 1, root: group, activeGroup: group.id, closed: [] },
    sessions: {},
    settings: { 'divider-thickness': 1 },
    rename: null,
    tabDrag: null,
    paneDrag: null,
    menu: null,
  }
  return <GroupTree controller={controller as never} state={state as never} node={group} />
}

const { stripFixture } = window as unknown as { stripFixture: StripFixture }
createRoot(document.getElementById('host')!).render(<Strip fixture={stripFixture} />)
