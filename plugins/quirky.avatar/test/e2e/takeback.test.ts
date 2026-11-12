import { afterEach, describe, expect, test } from 'bun:test'
import { waitFor } from '../../../../packages/daemon/test/helpers'
import type { JournalEntry, Mandate, ReportModel } from '../../src/contracts'
import { useTempAgentHome } from '../daemon-support'
import { bash, cleanupAll, startAvatar as startAvatarFixture, writeTo, type Avatar } from './fixtures'

const agent = useTempAgentHome()
const startAvatar = (options: Parameters<typeof startAvatarFixture>[0] = {}) => startAvatarFixture(options, agent)

afterEach(cleanupAll)

const JUDGED = 'bun test --update-snapshots'

/**
 * Sends a call that needs the brain and returns its still-waiting answer, boxed so awaiting the helper does not wait for it. The brain starts on the
 * first such call, which is refused as unavailable, so the call is repeated until one waits.
 */
async function waitingJudgment(avatar: Avatar, worktree = avatar.alpha, session = 'sess-alpha') {
  for (let attempt = 0; attempt < 50; attempt++) {
    const answer = avatar.gate(session, bash(worktree, JUDGED), { deadlineMs: 60_000 })
    const early = await Promise.race([answer, Bun.sleep(300).then(() => null)])
    if (early === null) return { answer }
    await Bun.sleep(50)
  }
  throw new Error('the brain never became ready')
}

describe('take-back with work in flight (SC-28)', () => {
  test('removes the marker, lists the held call, keeps the mandate and releases the waiting request as passthrough', async () => {
    const avatar = await startAvatar({ brain: 'ready' })
    const goal = 'Move the checkout form to the new validator'
    await avatar.handoff([
      { worktree: avatar.alpha, level: 'own-branch', goal },
      { worktree: avatar.beta, level: 'local' }
    ])
    await avatar.settle()

    const held = await avatar.gate('sess-alpha', writeTo(avatar.alpha, agent.sshConfig))
    expect(held.decision).toBe('deny')
    const [need] = (await avatar.call<ReportModel>('quirky.avatar/report')).needsYou
    expect(need).toMatchObject({ kind: 'held-call', worktreeId: avatar.alpha.id })

    const { answer: waiting } = await waitingJudgment(avatar)
    await waitFor(() => avatar.state.brain.sends.some((send) => send.text.includes(JUDGED)))
    expect(avatar.hasMarker('sess-alpha')).toBe(true)

    const { results } = await avatar.call<{ results: { worktreeId: string; ok: boolean; handedBackWith: string[] }[] }>('quirky.avatar/takeBack', { worktreeIds: [avatar.alpha.id] })
    expect(results).toEqual([{ worktreeId: avatar.alpha.id, ok: true, handedBackWith: [need!.title] }])

    const released = await waiting
    expect(released).toMatchObject({ decision: 'passthrough', encoded: '{}' })
    expect(released.reason).toContain('Handed back to the user')

    expect(avatar.hasMarker('sess-alpha')).toBe(false)
    expect(avatar.hasMarker('sess-beta')).toBe(true)
    expect(await avatar.shim('sess-alpha', writeTo(avatar.alpha, agent.sshConfig))).toMatchObject({ stdout: '{}\n', code: 0 })

    const mandate = await avatar.call<Mandate | null>('quirky.avatar/mandate', { worktreeId: avatar.alpha.id })
    expect(mandate).toMatchObject({ worktreeId: avatar.alpha.id, goal, level: 'own-branch' })

    const status = await avatar.call<{ handoffs: { worktreeId: string }[]; needsYouCount: number }>('quirky.avatar/status')
    expect(status.handoffs.map((row) => row.worktreeId)).toEqual([avatar.beta.id])
    expect(status.needsYouCount).toBe(0)

    const report = await avatar.call<ReportModel>('quirky.avatar/report')
    expect(report.needsYou).toEqual([])
    expect(report.stories.find((story) => story.worktreeId === avatar.alpha.id)).toMatchObject({ handedBackWith: [need!.title], story: expect.stringContaining('Handed back to you') })
    expect(report.stories.find((story) => story.worktreeId === avatar.beta.id)?.handedBackWith).toEqual([])

    const journal = await avatar.call<JournalEntry[]>('quirky.avatar/log', { worktreeId: avatar.alpha.id })
    expect(journal.find((entry) => entry.kind === 'take-back')).toMatchObject({ data: { handedBackWith: [need!.title] } })
    expect(journal.find((entry) => entry.kind === 'gate' && entry.data.reliedOn === 'take-back')).toMatchObject({ data: { outcome: 'passthrough' } })
  })

  test('a held call that was handed back can no longer be allowed once, and taking back twice does nothing', async () => {
    const avatar = await startAvatar()
    await avatar.handoff([{ worktree: avatar.alpha, level: 'own-branch' }])
    await avatar.settle()
    await avatar.gate('sess-alpha', bash(avatar.alpha, 'git push --force-with-lease origin feature'))
    const [need] = (await avatar.call<ReportModel>('quirky.avatar/report')).needsYou

    await avatar.call('quirky.avatar/takeBack', { all: true })
    expect(await avatar.call<unknown>('quirky.avatar/resolveNeed', { needId: need!.id, action: 'allow-once' })).toEqual({ ok: false, error: 'need already resolved' })
    expect(await avatar.call<unknown>('quirky.avatar/takeBack', { all: true })).toEqual({ results: [] })
  })

  test('handing the worktree off again keeps working from the stored mandate fields it is given', async () => {
    const avatar = await startAvatar()
    await avatar.handoff([{ worktree: avatar.alpha, level: 'local', goal: 'First goal' }])
    await avatar.settle()
    await avatar.call('quirky.avatar/takeBack', { worktreeIds: [avatar.alpha.id] })
    expect(avatar.hasMarker('sess-alpha')).toBe(false)

    await avatar.handoff([{ worktree: avatar.alpha, level: 'own-branch', goal: 'Second goal' }])
    await avatar.settle()
    expect(avatar.hasMarker('sess-alpha')).toBe(true)
    expect(await avatar.call<unknown>('quirky.avatar/mandate', { worktreeId: avatar.alpha.id })).toMatchObject({ goal: 'Second goal', level: 'own-branch' })
    expect((await avatar.call<{ handoffs: unknown[] }>('quirky.avatar/status')).handoffs).toHaveLength(1)
  })
})
