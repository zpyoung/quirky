import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { callsTo, click, conceptualWorkspace, fakeDaemon, loadWorkspace, mountFixture, session, simpleWorkspace, startRecording, stopRecording, unloadWorkspace, type MountedWorkspace } from './workspace-support'

let mounted: MountedWorkspace | null = null

beforeAll(loadWorkspace)
afterAll(unloadWorkspace)
beforeEach(startRecording)
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  stopRecording()
  document.body.innerHTML = ''
})

const badges: Session['badges'] = {
  'acme.handoff/lineage:1': { label: 'from Claude', tooltip: 'Jump to the source', command: 'command:acme.handoff/jump', args: { session: 's-9', lineage: '1' } },
  'acme.handoff/lineage:2': { label: 'to Codex' }
}

describe('the tab strip draws session badges', () => {
  test('one chip per badge after the title, with the label and tooltip', async () => {
    mounted = await mountFixture(fakeDaemon(simpleWorkspace(), { sessions: [session('s-1', { badges })] }))
    const tab = mounted.q('.qt-tab')!
    const chips = [...tab.querySelectorAll<HTMLElement>('.qt-badge')]
    expect(chips.map((chip) => chip.textContent)).toEqual(['from Claude', 'to Codex'])
    expect(chips[0]!.getAttribute('title')).toBe('Jump to the source')
    expect(chips[1]!.hasAttribute('title')).toBe(false)
    expect(chips[0]!.previousElementSibling).toBe(tab.querySelector('.qt-tab-title'))
  })

  test('a session with no badges draws none', async () => {
    mounted = await mountFixture(fakeDaemon(simpleWorkspace(), { sessions: [session('s-1')] }))
    expect(mounted.qa('.qt-badge')).toHaveLength(0)
  })

  test('the chips come from the lead session of the tab', async () => {
    mounted = await mountFixture(fakeDaemon(conceptualWorkspace(), { sessions: ['s-1', 's-2', 's-3', 's-4', 's-5'].map((id) => session(id, id === 's-3' ? { badges } : {})) }))
    const tabs = mounted.qa('.qt-tab')
    expect(tabs.map((tab) => tab.querySelectorAll('.qt-badge').length)).toEqual([0, 2, 0])
  })

  test('clicking a chip with a command runs it with its args and does not activate the tab', async () => {
    mounted = await mountFixture(fakeDaemon(conceptualWorkspace(), { sessions: ['s-1', 's-2', 's-3', 's-4', 's-5'].map((id) => session(id, id === 's-1' ? { badges } : {})) }))
    const executed: unknown[][] = []
    mounted.fake.context.executeCommand = async (...args: unknown[]) => void executed.push(args)
    const before = callsTo(mounted.fake, 'activateTab').length

    await click(mounted.q('[data-tab="tab-1"] .qt-badge'))

    expect(executed).toEqual([['command:acme.handoff/jump', { session: 's-9', lineage: '1' }]])
    expect(callsTo(mounted.fake, 'activateTab')).toHaveLength(before)
  })

  test('clicking a chip without a command runs nothing and falls through to the tab', async () => {
    mounted = await mountFixture(fakeDaemon(conceptualWorkspace(), { sessions: ['s-1', 's-2', 's-3', 's-4', 's-5'].map((id) => session(id, id === 's-1' ? { badges } : {})) }))
    const executed: unknown[][] = []
    mounted.fake.context.executeCommand = async (...args: unknown[]) => void executed.push(args)

    await click(mounted.qa('[data-tab="tab-1"] .qt-badge')[1]!)

    expect(executed).toEqual([])
    expect(callsTo(mounted.fake, 'activateTab')).toEqual([{ tab: 'tab-1' }])
  })
})

describe('the worktree view reports session badges', () => {
  test('a tab entry lists the key and label of each badge, and an entry without badges has no field', async () => {
    mounted = await mountFixture(fakeDaemon(conceptualWorkspace(), { sessions: ['s-1', 's-2', 's-3', 's-4', 's-5'].map((id) => session(id, id === 's-3' ? { badges } : {})) }))
    const tabs = mounted.last().tabs as { session: string; badges?: unknown }[]
    expect(tabs.find((entry) => entry.session === 's-3')!.badges).toEqual([
      { key: 'acme.handoff/lineage:1', label: 'from Claude' },
      { key: 'acme.handoff/lineage:2', label: 'to Codex' }
    ])
    expect(tabs.filter((entry) => 'badges' in entry).map((entry) => entry.session)).toEqual(['s-3'])
  })
})
