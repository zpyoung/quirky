import { afterEach, describe, expect, test } from 'bun:test'
import { waitFor } from '../../../../packages/daemon/test/helpers'
import type { Mandate } from '../../src/contracts'
import { testCliContext } from '../../../quirky.session/test/support'
import { useTempAgentHome } from '../daemon-support'
import { commands } from '../../cli'
import { cleanupAll, startAvatar as startAvatarFixture, type Avatar } from './fixtures'

const agent = useTempAgentHome()
const startAvatar = (options: Parameters<typeof startAvatarFixture>[0] = {}) => startAvatarFixture(options, agent)
afterEach(cleanupAll)

type HandoffArgs = Parameters<NonNullable<typeof commands.handoff>>[0]

async function handoff(avatar: Avatar, selector: string, flags: HandoffArgs['flags']): Promise<string[]> {
  const { ctx, lines } = testCliContext(avatar.client)
  await commands.handoff!({ positionals: [selector], flags }, ctx)

  const worktree = avatar.state.worktrees.find((entry) => entry.name === selector)
  if (worktree === undefined) throw new Error(`missing fixture worktree ${selector}`)
  const session = avatar.state.sessions.find((entry) => entry.worktreeId === worktree.id)
  if (session === undefined) throw new Error(`missing fixture session for ${selector}`)
  await waitFor(() => avatar.state.inspected.includes(session.id))
  return lines
}

async function expectNoHandoffs(avatar: Avatar): Promise<void> {
  const status = await avatar.call<{ handoffs: unknown[] }>('quirky.avatar/status')
  expect(status.handoffs).toEqual([])
}

describe('avatar CLI against a daemon', () => {
  test('a bare hand-off gets the default level and switches from settings', async () => {
    const avatar = await startAvatar()
    await avatar.call('quirky.avatar/setSettings', { defaultLevel: 'local', switches: { messaging: true } })

    const lines = await handoff(avatar, 'alpha', { goal: 'Fix the build', 'done-when': 'bun test' })

    expect(lines).toEqual(['Handed off alpha to the avatar.'])
    const mandate = await avatar.call<Mandate | null>('quirky.avatar/mandate', { worktreeId: 'wt-alpha' })
    expect(mandate).toMatchObject({
      goal: 'Fix the build',
      doneWhen: 'bun test',
      level: 'local',
      switches: { messaging: true, historyRewrite: false, deploys: false },
      agent: null
    })
  })

  test('typed level, switches and guidelines override defaults per field', async () => {
    const avatar = await startAvatar()
    await avatar.call('quirky.avatar/setSettings', { defaultLevel: 'local', switches: { messaging: true } })

    await handoff(avatar, 'beta', {
      goal: 'g',
      'done-when': 'd',
      level: 'own-branch',
      switch: ['deploys', 'messaging=false'],
      guideline: ['small commits']
    })

    const mandate = await avatar.call<Mandate | null>('quirky.avatar/mandate', { worktreeId: 'wt-beta' })
    expect(mandate).toMatchObject({
      level: 'own-branch',
      switches: { messaging: false, historyRewrite: false, deploys: true },
      guidelines: ['small commits']
    })
  })

  test('one boolean switch flag overrides only messaging', async () => {
    const avatar = await startAvatar()

    await handoff(avatar, 'alpha', { goal: 'g', 'done-when': 'd', 'allow-messaging': true })

    const mandate = await avatar.call<Mandate | null>('quirky.avatar/mandate', { worktreeId: 'wt-alpha' })
    expect(mandate).toMatchObject({
      level: 'full',
      switches: { messaging: true, historyRewrite: false, deploys: false }
    })
  })

  test('a folder hand-off fails without printing output', async () => {
    const avatar = await startAvatar()
    const { ctx, lines } = testCliContext(avatar.client)

    await expect(commands.handoff!({
      positionals: ['gamma'],
      flags: { goal: 'g', 'done-when': 'd' }
    }, ctx)).rejects.toMatchObject({
      kind: 'fail',
      message: expect.stringContaining("Can't hand off: not a git worktree")
    })
    expect(lines).toEqual([])
  })

  test('status, log, report and take-back work, including empty take-back --all', async () => {
    const avatar = await startAvatar()
    await avatar.call('quirky.avatar/setSettings', { defaultLevel: 'local', switches: { messaging: true } })
    expect(await handoff(avatar, 'alpha', { goal: 'Fix the build', 'done-when': 'bun test' })).toEqual([
      'Handed off alpha to the avatar.'
    ])

    const status = testCliContext(avatar.client)
    await commands.status!({ positionals: [], flags: {} }, status.ctx)
    expect(status.lines).toHaveLength(1)
    expect(status.lines[0]).toContain('alpha')
    expect(status.lines[0]).toContain('local')

    const log = testCliContext(avatar.client)
    await commands.log!({ positionals: [], flags: { worktree: 'alpha', limit: 5 } }, log.ctx)
    expect(log.lines).toHaveLength(1)
    expect(log.lines[0]).toContain('handoff')

    const report = testCliContext(avatar.client)
    await commands.report!({ positionals: [], flags: {} }, report.ctx)
    expect(report.lines).toEqual([expect.any(String)])

    const takeBack = testCliContext(avatar.client)
    await commands['take-back']!({ positionals: ['alpha'], flags: {} }, takeBack.ctx)
    expect(takeBack.lines).toEqual(['Took back wt-alpha'])

    const emptyStatus = testCliContext(avatar.client)
    await commands.status!({ positionals: [], flags: {} }, emptyStatus.ctx)
    expect(emptyStatus.lines).toEqual(['Nothing is handed off to the avatar.'])

    const emptyTakeBack = testCliContext(avatar.client)
    await commands['take-back']!({ positionals: [], flags: { all: true } }, emptyTakeBack.ctx)
    expect(emptyTakeBack.lines).toEqual(['Nothing was handed off.'])
  })

  test('the daemon schema rejects unknown switches and levels before hand-off', async () => {
    const avatar = await startAvatar()

    await expect(avatar.call('quirky.avatar/handoff', {
      items: [{ worktreeId: 'wt-alpha', goal: 'g', doneWhen: 'd', switches: { teleport: true } }]
    })).rejects.toThrow('params.items[0].switches.teleport is not allowed')
    await expectNoHandoffs(avatar)

    await expect(avatar.call('quirky.avatar/handoff', {
      items: [{ worktreeId: 'wt-alpha', goal: 'g', doneWhen: 'd', level: 'Full' }]
    })).rejects.toThrow('params.items[0].level must be one of shadow, local, own-branch, full')
    await expectNoHandoffs(avatar)
  })
})
