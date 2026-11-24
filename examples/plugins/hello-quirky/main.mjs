// Sample Quirky plugin worker entry. Runs inside the out-of-process plugin
// worker (plain Node, no Electron), forked lazily on the first trigger. The
// default export receives the `quirky` API: command registration, event
// handlers, and the capability-gated host API.
export default function activate(quirky) {
  quirky.commands.register('hello-ping', async (args) => {
    const stored = await quirky.host.call('storage.get', { key: 'pings' })
    const count = (typeof stored?.value === 'number' ? stored.value : 0) + 1
    await quirky.host.call('storage.set', { key: 'pings', value: count })
    return { pong: true, count, args: args ?? null }
  })

  quirky.events.on('worktree.created', async (payload) => {
    quirky.log(`worktree created: ${payload.worktreeId} at ${payload.path}`)
    await quirky.host.call('notifications.show', {
      title: 'Worktree created',
      body: payload.path
    })
  })

  quirky.events.on('agent.status.changed', (payload) => {
    quirky.log(`agent status: ${payload.state} in ${payload.worktreeId ?? 'unknown worktree'}`)
  })
}
