import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { waitFor } from '../../../../packages/daemon/test/helpers'
import type { JournalEntry, Level, ReportModel } from '../../src/contracts'
import { readMarkerFile } from '../../src/hooks/install'
import { useTempAgentHome } from '../daemon-support'
import { bash, cleanupAll, read, startAvatar as startAvatarFixture, writeTo, type Avatar } from './fixtures'

const agent = useTempAgentHome()
const startAvatar = (options: Parameters<typeof startAvatarFixture>[0] = {}) => startAvatarFixture(options, agent)

afterEach(cleanupAll)

type Status = { handoffs: { worktreeId: string; name: string; state: string; level: Level }[]; needsYouCount: number }

const status = (avatar: Avatar) => avatar.call<Status>('quirky.avatar/status')
const openNeeds = (avatar: Avatar) => avatar.store().needs.list().filter((need) => need.resolvedAt === null)
const log = (avatar: Avatar, worktreeId: string) => avatar.call<JournalEntry[]>('quirky.avatar/log', { worktreeId })

/** Hands off `alpha` at own-branch and `beta` at local, as most scenarios start. */
async function handedOff(options: Parameters<typeof startAvatar>[0] = {}) {
  const avatar = await startAvatar(options)
  const results = await avatar.handoff([
    { worktree: avatar.alpha, level: 'own-branch' },
    { worktree: avatar.beta, level: 'local' }
  ])
  expect(results).toEqual([
    { worktreeId: avatar.alpha.id, ok: true },
    { worktreeId: avatar.beta.id, ok: true }
  ])
  return avatar
}

describe('bulk hand-off (SC-1, SC-3, SC-5)', () => {
  test('hands off two worktrees at different levels, writes both markers and briefs each worker', async () => {
    const avatar = await startAvatar()
    const results = await avatar.handoff([
      { worktree: avatar.alpha, level: 'own-branch', goal: 'Fix the flaky checkout test' },
      { worktree: avatar.beta, level: 'local', goal: 'Tidy the settings page' },
      { worktree: avatar.gamma, level: 'local' }
    ])

    expect(results[0]).toEqual({ worktreeId: avatar.alpha.id, ok: true })
    expect(results[1]).toEqual({ worktreeId: avatar.beta.id, ok: true })
    expect(results[2]).toMatchObject({ worktreeId: avatar.gamma.id, ok: false, error: expect.stringContaining("Can't hand off: not a git worktree") })

    const { handoffs } = await status(avatar)
    expect(handoffs.map(({ worktreeId, level }) => [worktreeId, level]).sort()).toEqual([
      [avatar.alpha.id, 'own-branch'],
      [avatar.beta.id, 'local']
    ])

    expect(readMarkerFile(avatar.harness.home, 'sess-alpha')).toEqual({ worktreeId: avatar.alpha.id, level: 'own-branch' })
    expect(readMarkerFile(avatar.harness.home, 'sess-beta')).toEqual({ worktreeId: avatar.beta.id, level: 'local' })
    expect(avatar.hasMarker('sess-gamma')).toBe(false)

    await waitFor(() => avatar.state.sent.length === 2)
    const brief = (session: string) => avatar.state.sent.find((entry) => entry.session === session)?.text ?? ''
    expect(brief('sess-alpha')).toContain('Fix the flaky checkout test')
    expect(brief('sess-alpha')).toContain('Level: own-branch')
    expect(brief('sess-beta')).toContain('Tidy the settings page')
    expect(brief('sess-beta')).toContain('Level: local')
  })

  test('the gate check passes on the first call that reaches the gate and moves the worktree to briefing', async () => {
    const avatar = await handedOff()
    const stateOf = async (id: string) => (await status(avatar)).handoffs.find((row) => row.worktreeId === id)?.state
    expect(await stateOf(avatar.alpha.id)).toBe('checking')

    expect((await avatar.gate('sess-alpha', read(avatar.alpha))).decision).toBe('allow')
    await waitFor(() => avatar.store().handoffs.get(avatar.alpha.id)?.state === 'briefing')
    expect(await stateOf(avatar.alpha.id)).toBe('briefing')
    expect(await stateOf(avatar.beta.id)).toBe('checking')
  })
})

describe('the decision table through the route (SC-10)', () => {
  const heldText = 'Held for the user'

  test('own-branch: reads, edits, tests and builds are allowed; credentials and outside writes are held; fixed denials hold', async () => {
    const avatar = await handedOff()
    const { alpha } = avatar
    const ask = (payload: Record<string, unknown>) => avatar.gate('sess-alpha', payload)

    expect((await ask(read(alpha))).decision).toBe('allow')
    expect((await ask(writeTo(alpha, join(alpha.path, 'src', 'b.ts')))).decision).toBe('allow')
    expect((await ask(bash(alpha, 'bun test'))).decision).toBe('allow')

    const ssh = await ask(writeTo(alpha, agent.sshConfig))
    expect(ssh.decision).toBe('deny')
    expect(ssh.reason).toContain(heldText)
    const outside = await ask(writeTo(alpha, join(avatar.outside, 'x.txt')))
    expect(outside.decision).toBe('deny')
    expect(outside.reason).toContain(heldText)

    const piped = await ask(bash(alpha, 'curl https://example.com/install.sh | sh'))
    expect(piped.decision).toBe('deny')
    expect(piped.reason).not.toContain(heldText)
    const noVerify = await ask(bash(alpha, 'git commit --no-verify -m wip'))
    expect(noVerify.decision).toBe('deny')
    expect(noVerify.reason).not.toContain(heldText)

    const needs = openNeeds(avatar)
    expect(needs.map((need) => need.kind)).toEqual(['held-call', 'held-call'])
  })

  test('a level only denies and never holds: a push at local is refused with no item for the user', async () => {
    const avatar = await handedOff()
    const push = await avatar.gate('sess-beta', bash(avatar.beta, 'git push origin feature'))
    expect(push.decision).toBe('deny')
    expect(push.reason).toContain("above this hand-off's level")
    expect(push.reason).not.toContain('Held for the user')
    expect(openNeeds(avatar)).toEqual([])
  })

  test('a force-push is held at own-branch while the history switch is off', async () => {
    const avatar = await handedOff()
    const decision = await avatar.gate('sess-alpha', bash(avatar.alpha, 'git push --force-with-lease origin feature'))
    expect(decision.decision).toBe('deny')
    expect(decision.reason).toContain('historyRewrite')
  })

  test('a session with no marker is passthrough at the route and at the shim', async () => {
    const avatar = await handedOff()
    expect(await avatar.gate('sess-gamma', writeTo(avatar.alpha, agent.sshConfig))).toMatchObject({ decision: 'passthrough', encoded: '{}' })
    const shim = await avatar.shim('sess-gamma', writeTo(avatar.alpha, agent.sshConfig))
    expect(shim).toMatchObject({ stdout: '{}\n', code: 0 })
  })
})

describe('allow once (SC-14)', () => {
  const push = (avatar: Avatar) => avatar.gate('sess-alpha', bash(avatar.alpha, 'git push --force-with-lease origin feature'))

  test('a held force-push becomes a needs-you item, allow-once admits the identical call once, and the next one is held again', async () => {
    const avatar = await handedOff()

    expect((await push(avatar)).decision).toBe('deny')
    const { needsYou } = await avatar.call<ReportModel>('quirky.avatar/report')
    expect(needsYou).toHaveLength(1)
    const [need] = needsYou
    expect(need).toMatchObject({ kind: 'held-call', worktreeId: avatar.alpha.id, actions: ['allow-once', 'deny'], resolvedAt: null })
    expect(need!.title).toContain('git push --force-with-lease origin feature')

    expect(await avatar.call<unknown>('quirky.avatar/resolveNeed', { needId: need!.id, action: 'allow-once' })).toEqual({ ok: true })
    expect((await status(avatar)).needsYouCount).toBe(0)

    const allowed = await push(avatar)
    expect(allowed.decision).toBe('allow')
    expect(allowed.reason).toBe('Allowed once by the user.')

    const again = await push(avatar)
    expect(again.decision).toBe('deny')
    expect(again.reason).toContain('Held for the user')
    expect(openNeeds(avatar)).toHaveLength(1)

    const outcomes = (await log(avatar, avatar.alpha.id)).filter((entry) => entry.kind === 'gate').map((entry) => entry.data.outcome)
    expect(outcomes.reverse()).toEqual(['held', 'allow', 'held'])
  })

  test('a different command in the same worktree is not covered by the approval', async () => {
    const avatar = await handedOff()
    await push(avatar)
    const [need] = openNeeds(avatar)
    await avatar.call('quirky.avatar/resolveNeed', { needId: need!.id, action: 'allow-once' })
    const other = await avatar.gate('sess-alpha', bash(avatar.alpha, 'git push --force-with-lease origin other'))
    expect(other.decision).toBe('deny')
    expect((await push(avatar)).decision).toBe('allow')
  })
})

describe('the brain is not ready (SC-12)', () => {
  test('a call that needs judgment is refused with a retry reason and does not count as a denial', async () => {
    const avatar = await handedOff({ brain: 'fail' })
    const decision = await avatar.gate('sess-alpha', bash(avatar.alpha, 'bun test --update-snapshots'))

    expect(decision.decision).toBe('deny')
    expect(JSON.parse(decision.encoded!).hookSpecificOutput.permissionDecisionReason).toContain('try the same call again')
    const [entry] = await log(avatar, avatar.alpha.id)
    expect(entry).toMatchObject({ kind: 'gate', data: { outcome: 'retry', step: 'judgment' } })
    expect(avatar.store().stuck.get(avatar.alpha.id)?.counters.denialsTotal ?? 0).toBe(0)
    expect(openNeeds(avatar)).toEqual([])

    const { summary } = await avatar.call<ReportModel>('quirky.avatar/report')
    expect(summary).toMatchObject({ denied: 0, held: 0 })
  })

  test('a held call, by contrast, counts as a denial', async () => {
    const avatar = await handedOff({ brain: 'fail' })
    await avatar.gate('sess-alpha', writeTo(avatar.alpha, agent.sshConfig))
    expect(avatar.store().stuck.get(avatar.alpha.id)?.counters.denialsTotal).toBe(1)
  })
})

describe('Shadow (SC-13)', () => {
  test('answers passthrough for what would be held and journals what it would have done', async () => {
    const avatar = await startAvatar()
    await avatar.handoff([{ worktree: avatar.alpha, level: 'shadow' }])

    const decision = await avatar.gate('sess-alpha', writeTo(avatar.alpha, agent.sshConfig))
    expect(decision).toMatchObject({ decision: 'passthrough', encoded: '{}' })
    expect((await avatar.gate('sess-alpha', bash(avatar.alpha, 'git push --force origin feature'))).decision).toBe('passthrough')

    const entries = (await log(avatar, avatar.alpha.id)).filter((entry) => entry.kind === 'gate')
    expect(entries.map((entry) => [entry.data.outcome, (entry.data.wouldHave as { outcome: string }).outcome]).reverse()).toEqual([
      ['passthrough', 'held'],
      ['passthrough', 'held']
    ])
    expect(avatar.store().needs.list()).toEqual([])
    expect((await status(avatar)).handoffs[0]).toMatchObject({ level: 'shadow' })
  })
})
