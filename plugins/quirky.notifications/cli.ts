import type { CliModule } from '@quirky/protocol'

type Status = {
  badge: number
  unreadWorktrees: { id: string; name: string }[]
  unreadSessions: { id: string; worktreeId: string; reason: string }[]
  pendingAsks: number
  sound: { ok: boolean; reason?: string }
}

type Delivery = { delivered: boolean; reason: string }

export const commands: CliModule['commands'] = {
  async status(_args, ctx) {
    const status = (await ctx.call('quirky.notifications/status', {})) as Status
    ctx.out.result(status, () =>
      [
        `badge ${status.badge}`,
        ...status.unreadWorktrees.map((worktree) => `worktree ${worktree.id} ${worktree.name}`),
        ...status.unreadSessions.map((session) => `session ${session.id} ${session.worktreeId} ${session.reason}`),
        `asks ${status.pendingAsks}`,
        `sound ${status.sound.ok ? 'ok' : (status.sound.reason ?? 'unavailable')}`
      ].join('\n')
    )
  },

  async send(args, ctx) {
    const { body, title, session, worktree } = args.flags
    if (typeof body !== 'string' || body === '') throw ctx.usage('missing --body')
    if (session !== undefined && worktree !== undefined) throw ctx.usage('pass --session or --worktree, not both')
    const params: Record<string, unknown> = { body }
    if (typeof title === 'string') params.title = title
    if (typeof session === 'string') params.session = session
    if (typeof worktree === 'string') {
      const resolved = (await ctx.call('quirky.worktree/resolve', { selector: worktree })) as { id: string }
      params.worktree = resolved.id
    }
    const result = (await ctx.call('quirky.notifications/send', params)) as Delivery
    ctx.out.result(result, () => result.reason)
  },

  async test(_args, ctx) {
    const result = (await ctx.call('quirky.notifications/test', {})) as Delivery
    ctx.out.result(result, () => result.reason)
  },

  async preview(args, ctx) {
    const { sound, path, volume } = args.flags
    const params: Record<string, unknown> = {}
    if (typeof sound === 'string') params.sound = sound
    if (typeof path === 'string') params.path = path
    if (typeof volume === 'number') params.volume = volume
    const result = (await ctx.call('quirky.notifications/preview', params)) as { played: boolean; reason?: string }
    ctx.out.result(result, () => (result.played ? 'played' : (result.reason ?? 'not played')))
  }
}
