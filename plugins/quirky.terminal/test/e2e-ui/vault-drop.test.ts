import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PublicListResult } from '../../../quirky.vault/src/types'
import { startAgentsE2E, type E2E } from '../../../quirky.agents/test/support/e2e'
import {
  FEATURE_MS,
  attachFeatures,
  groupsOf,
  layoutOf,
  leavesOf,
  stopAll,
  terminal,
  waitFor,
  type Features,
  type Workspace
} from './features-support'

let agents: E2E | undefined

afterEach(async () => {
  await stopAll()
  await agents?.cleanup()
  agents = undefined
})

const MIME = 'application/x-quirky-command'

function writeSource(home: string): void {
  const root = join(home, '.claude', 'projects', 'drop-fixtures')
  mkdirSync(root, { recursive: true })
  const records = [
    {
      type: 'user',
      sessionId: 'vault-drop-provider-session',
      cwd: home,
      timestamp: '2026-10-27T11:00:00.000Z',
      message: { role: 'user', content: 'Continue the exact source session' }
    },
    {
      type: 'assistant',
      sessionId: 'vault-drop-provider-session',
      cwd: home,
      timestamp: '2026-10-27T11:01:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'A real provider resume must be placed in the drop target.' }] }
    }
  ]
  writeFileSync(join(root, 'vault-drop-provider-session.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}

function dropCommand(features: Features, group: string, command: string, args: Record<string, unknown>): void {
  const body = features.win.document.querySelector<HTMLElement>(`[data-group-body="${group}"]`)
  if (!body) throw new Error(`the target group ${group} is not mounted`)
  const payload = JSON.stringify({ command, args })
  const transfer = {
    types: [MIME],
    getData(type: string) {
      return type === MIME ? payload : ''
    }
  }
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  body.dispatchEvent(event)
}

test(
  'SC-20: a declared vault resume drop launches once into its explicit nonactive group and worktree',
  async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'quirky-vault-drop-'))
    try {
      writeSource(sourceHome)
      const agentHarness = await startAgentsE2E({
        fakes: { claude: true },
        extraEnv: { QUIRKY_VAULT_SOURCE_HOME: sourceHome }
      })
      agents = agentHarness
      const features = await attachFeatures(agentHarness)
      const { h } = features
      const source = await h.call<PublicListResult>('quirky.vault/list', { unlimited: true })
      const session = source.sessions.find((entry) => entry.sessionId === 'vault-drop-provider-session')!
      expect(session).toBeDefined()

      const initial = await layoutOf(h)
      const sourceTab = tabsOf(initial)[0]!
      const sourceGroup = groupsOf(initial).find((group) => group.tabs.some((tab) => tab.id === sourceTab.id))!
      const existingTabs = new Set(tabsOf(initial).map((tab) => tab.id))
      const { workspace: withDestination } = await terminal<{ workspace: Workspace }>(h, 'tab', 'new')
      const destination = tabsOf(withDestination).find((tab) => !existingTabs.has(tab.id))!
      const destinationId = destination.id
      await terminal(h, 'tab', 'rename', destinationId, 'Vault target')
      await terminal(h, 'tab', 'move', destinationId, '--split', 'right', '--of', sourceGroup.id)
      let layout = await waitFor('two tab groups', async () => {
        const candidate = await layoutOf(h)
        return groupsOf(candidate).length === 2 ? candidate : undefined
      })
      const sourceGroupNow = groupsOf(layout).find((group) => group.tabs.some((tab) => tab.id === sourceTab.id))!
      const targetGroup = groupsOf(layout).find((group) => group.tabs.some((tab) => tab.id === destinationId))!
      await terminal(h, 'tab', 'activate', sourceTab.id)
      layout = await waitFor('the source group as active', async () => {
        const candidate = await layoutOf(h)
        return candidate.activeGroup === sourceGroupNow.id ? candidate : undefined
      })
      expect(layout.activeGroup).not.toBe(targetGroup.id)

      dropCommand(features, targetGroup.id, 'command:quirky.vault/resume', { id: session.id, group: 'spoofed-group', worktree: 'spoofed-worktree' })
      layout = await waitFor(
        'one resumed tab in the exact target group',
        async () => {
          const candidate = await layoutOf(h)
          return groupsOf(candidate).find((group) => group.id === targetGroup.id)?.tabs.length === 2 ? candidate : undefined
        }
      )
      const target = groupsOf(layout).find((group) => group.id === targetGroup.id)!
      const resumed = target.tabs.find((tab) => tab.id !== destinationId)!
      const pane = leavesOf(resumed.root)[0]!
      const records = await h.call<{ id: string; agent: string; worktreeId: string | null }[]>('quirky.session/list', { worktree: layout.id })
      expect(records.find((entry) => entry.id === pane.session)).toMatchObject({ agent: 'claude', worktreeId: layout.id })
      expect(groupsOf(layout).find((group) => group.id === targetGroup.id)?.tabs.some((tab) => tab.id === resumed.id)).toBe(true)

      const starts = await waitFor('the source identity to launch once', async () => {
        const launched = agentHarness.fakeLog('claude').filter((event) => event.type === 'start')
        return launched.length === 1 ? launched : undefined
      }, 20_000)
      expect(starts).toHaveLength(1)
      expect(starts[0]!.argv).toContain('vault-drop-provider-session')

      dropCommand(features, targetGroup.id, 'command:quirky.vault/resume', { id: 'missing-vault-source' })
      await waitFor(
        'refusal of a missing source session',
        () => features.win.document.querySelector('.toast .toast-title')?.textContent === 'Could not run dropped command' ? true : undefined,
        20_000
      )
      const refused = await layoutOf(h)
      expect(groupsOf(refused).find((group) => group.id === targetGroup.id)?.tabs).toHaveLength(2)
      expect(agentHarness.fakeLog('claude').filter((event) => event.type === 'start')).toHaveLength(1)
    } finally {
      rmSync(sourceHome, { recursive: true, force: true })
    }
  },
  FEATURE_MS
)
