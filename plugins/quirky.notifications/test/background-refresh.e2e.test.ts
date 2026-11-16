import { expect, test } from 'bun:test'
import { useTestGit } from '@quirky/git/testing'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { Rig } from './support'

// real RPC latency is measured against held Git; a fake clock cannot time the daemon path.
async function within<T>(pending: Promise<T>, ms: number): Promise<T> {
  const deadline = Promise.withResolvers<never>()
  const timer = setTimeout(() => deadline.reject(new Error(`delivery did not finish within ${ms}ms`)), ms)
  try {
    return await Promise.race([pending, deadline.promise])
  } finally {
    clearTimeout(timer)
  }
}

test('public notification delivery does not wait for held Git discovery and applies its eventual badge', async () => {
  const rig = await Rig.start()
  const gate = Promise.withResolvers<void>()
  try {
    await rig.setting('sound', 'system')
    await rig.win.blur()
    const first = await rig.worktree('first-unread')
    const second = await rig.worktree('second-unread')
    await rig.client.callAny('quirky.worktree/set', { worktree: `id:${first.id}`, unread: true })
    await waitFor(() => rig.pluginEvents('changed').find(({ badge }) => badge === 1), 4000)
    await rig.client.callAny('quirky.worktree/list', {})

    let entered = false
    useTestGit({
      ...rig.git,
      listRegistrations: async (...args: Parameters<typeof rig.git.listRegistrations>) => {
        entered = true
        await gate.promise
        return rig.git.listRegistrations(...args)
      }
    })
    const from = rig.pluginEvents('changed').length
    await rig.client.callAny('quirky.worktree/set', { worktree: `id:${second.id}`, unread: true })
    await waitFor(() => entered || null, 4000)

    expect(await within(rig.client.callAny('quirky.notifications/test', {}), 500)).toEqual({ delivered: true, reason: 'delivered' })
    expect(rig.notifies()).toHaveLength(1)
    expect(rig.pluginEvents('changed').slice(from).some(({ badge }) => badge === 0)).toBe(false)

    gate.resolve()
    await waitFor(() => rig.pluginEvents('changed').find(({ badge }) => badge === 2), 4000)
    expect((await rig.status()).unreadWorktrees.map(({ id }) => id).sort()).toEqual([first.id, second.id].sort())
  } finally {
    gate.resolve()
    await rig.cleanup()
  }
}, 30_000)
