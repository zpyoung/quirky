import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo, Worktree } from '@quirky/protocol'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { Rig } from './support'

let rig: Rig
afterEach(() => rig?.cleanup())

describe('banner text', () => {
  test('SC-19: an agent\'s banner names the place, the agent and the status', async () => {
    rig = await Rig.start()
    const s = await rig.session('fix-tests', 'claude')

    await rig.claudeTurn(s.id, 'All green.\n\nRan 412 tests.')
    await rig.waitDecided(1)

    expect(rig.notifies()).toMatchObject([
      {
        title: 'quirky / fix-tests - Claude finished',
        body: 'All green. Ran 412 tests.',
        sessionId: s.id,
        worktreeId: rig.worktrees['fix-tests']!.id,
        open: { view: 'view:quirky.session/worktree', input: { worktree: rig.worktrees['fix-tests']!.id, session: s.id } }
      }
    ])
  })

  test('SC-20: the body falls back from message to tool to a sentence', async () => {
    rig = await Rig.start({ cooldownMs: 1 })
    const waiting = await rig.session('b', 'claude')
    await rig.hook('claude', waiting.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await rig.hook('claude', waiting.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } })
    await rig.waitDecided(1)
    const finished = await rig.session('c', 'claude')
    await rig.claudeTurn(finished.id)
    await rig.waitDecided(2)

    expect(rig.notifies().map((n) => [n.title, n.body])).toEqual([
      ['quirky / b - Claude needs input', 'Using Bash: npm test'],
      ['quirky / c - Claude finished', 'Claude finished.']
    ])
  })

  test('SC-21: long text is cut with an ellipsis, never through a character', async () => {
    rig = await Rig.start()
    const name = 'w'.repeat(100)
    const s = await rig.session(name, 'claude')

    await rig.claudeTurn(s.id, `${'x'.repeat(179)}😀${'y'.repeat(120)}`)
    await rig.waitDecided(1)

    const [event] = rig.notifies()
    const context = event!.title.slice(0, event!.title.indexOf(' - Claude'))
    expect(context).toHaveLength(80)
    expect(context.endsWith('…')).toBe(true)
    expect(event!.body.length).toBeLessThanOrEqual(180)
    expect(event!.body.endsWith('…')).toBe(true)
    const last = event!.body.charCodeAt(event!.body.length - 2)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
  })

  test('SC-22: a bell\'s banner', async () => {
    rig = await Rig.start()
    await rig.setting('terminalBell', true)
    const s = await rig.session('fix-tests')

    rig.bell(s.id)
    await rig.waitDecided(1)

    expect(rig.notifies()).toMatchObject([{ title: 'Bell in fix-tests', body: 'quirky · Attention requested' }])
  })

  test('SC-24: a folder workspace has no repo in its title', async () => {
    rig = await Rig.start()
    const folder = makeTempDir('qn-folder-')
    const notes = join(folder, 'notes')
    mkdirSync(notes)
    const repo = (await rig.client.callAny('quirky.repo/add', { path: notes, folder: true })) as Repo
    const worktree = ((await rig.client.callAny('quirky.worktree/list', { repo: repo.id })) as Worktree[])[0]!
    expect(worktree.kind).toBe('folder')
    const s = (await rig.client.callAny('quirky.session/create', { worktree: worktree.id, agent: 'claude' })) as { id: string }

    await rig.claudeTurn(s.id)
    await rig.waitDecided(1)

    expect(rig.notifies()[0]!.title).toBe('notes - Claude finished')
  })

  test('SC-29: a program\'s banner is titled with the worktree', async () => {
    rig = await Rig.start()
    const s = await rig.session('fix-tests')

    rig.oscNotify(s.id, 'Build', 'done in 4s')
    await rig.waitDecided(1)

    expect(rig.notifies()).toMatchObject([{ title: 'fix-tests: Build', body: 'done in 4s' }])
    expect((await rig.getSession(s.id)).unread).toBe('notification')
  })

  test('SC-30: a program notification without a title reads "Notification in <worktree>"', async () => {
    rig = await Rig.start()
    const s = await rig.session('fix-tests')

    rig.oscNotify(s.id, null, 'Tests passed')
    await rig.waitDecided(1)

    expect(rig.notifies()).toMatchObject([{ title: 'Notification in fix-tests', body: 'Tests passed' }])
  })
})
