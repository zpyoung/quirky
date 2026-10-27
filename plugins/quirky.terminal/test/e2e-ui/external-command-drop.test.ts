import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  FEATURE_MS,
  groupsOf,
  startFeatures,
  stopAll,
  viewReport,
  waitFor,
  type Features,
  type ViewReport
} from './features-support'

const COMMAND_MIME = 'application/x-quirky-command'

let ownedSourceHome: string | undefined

afterEach(async () => {
  try {
    await stopAll()
  } finally {
    if (ownedSourceHome) {
      rmSync(ownedSourceHome, { recursive: true, force: true })
      ownedSourceHome = undefined
    }
  }
})

function dropExternalCommand(features: Features, groupId: string): void {
  const body = features.win.document.querySelector<HTMLElement>(`[data-group-body="${groupId}"]`)
  if (!body) throw new Error(`the target group ${groupId} is not mounted`)

  const payload = JSON.stringify({
    command: 'command:quirky.terminal/open-menu',
    args: { kind: 'tab' }
  })
  const transfer = {
    types: [COMMAND_MIME],
    getData(type: string) {
      return type === COMMAND_MIME ? payload : ''
    }
  }
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  body.dispatchEvent(event)
}

function viewIdentity(report: ViewReport) {
  return {
    worktree: report.worktree,
    active: report.active,
    focusedPane: report.focusedPane,
    visibleSessions: report.visibleSessions,
    tabs: report.tabs.map((tab) => tab.session),
    groups: report.layout ? groupsOf(report.layout).map((group) => ({ id: group.id, tabs: group.tabs.map((tab) => tab.id) })) : [],
    dialog: report.dialog
  }
}

async function settleDrop(features: Features, firstCall: number, groupId: string): Promise<void> {
  const validation = features.calls.slice(firstCall).find(
    (call) => call.method === 'quirky.terminal/groupInfo' && call.params.group === groupId
  )
  if (!validation) return

  // The controller awaits this validation before dispatching the registered UI command.
  await waitFor('the external drop validation to settle', () => validation.settled ? true : undefined, FEATURE_MS)
}

test(
  'an external command MIME drop cannot dispatch a registered UI command',
  async () => {
    ownedSourceHome = mkdtempSync(join(tmpdir(), 'quirky-external-command-drop-'))
    const features = await startFeatures({ env: { QUIRKY_VAULT_SOURCE_HOME: ownedSourceHome } })

    const before = await viewReport(features, 'the mounted main worktree')
    if (!before.layout) throw new Error('the main worktree view has no workspace layout')
    const group = groupsOf(before.layout)[0]
    if (!group) throw new Error('the main worktree has no mounted tab group')

    expect(before.menu).toBeNull()
    const firstCall = features.calls.length
    dropExternalCommand(features, group.id)
    await settleDrop(features, firstCall, group.id)

    const after = await viewReport(features, 'the main worktree after the external drop')
    expect(after.menu).toBeNull()
    expect(features.win.document.querySelector('[role="menu"]')).toBeNull()
    expect(viewIdentity(after)).toEqual(viewIdentity(before))
  },
  FEATURE_MS
)
