import type { PluginCaller, PluginContext } from '@quirky/protocol'
import { NotificationReplay, type NotificationPoll } from './notification-replay'
import { readDesktopAway } from './notification-presence'

/** Notification-only admission avoids exposing the kernel's unrestricted event catalog. */
export function registerMobileNotifications(context: PluginContext): () => void {
  const replay = new NotificationReplay()
  let stopped = false
  let recording = Promise.resolve()
  const unsubscribe = context.subscribe(event => {
    if (event.type !== 'notify' || event.desktop === false) return
    recording = recording.then(async () => {
      const away = await readDesktopAway()
      if (stopped) return
      replay.append({ title: event.title, body: event.body,
        ...(event.worktreeId ? { worktreeId: event.worktreeId } : {}),
        ...(event.sessionId ? { sessionId: event.sessionId } : {}) }, away)
    }).catch(error => context.log(`Mobile notification capture failed: ${error instanceof Error ? error.name : 'unknown error'}`))
  })
  context.provide('method:quirky.mobile/notificationPoll', async (params: NotificationPoll, caller: PluginCaller) => {
    if (caller.role === 'plugin' || !caller.connection) throw context.error('invalid-params', 'notification polling requires a client connection')
    const connection = caller.connection
    const deviceId = caller.role === 'mobile' ? caller.deviceId : `local:${connection.id}`
    if (!deviceId) throw context.error('invalid-params', 'authenticated device identity is required')
    const abort = new AbortController()
    const unsubscribeClose = connection.onClose(() => abort.abort())
    try {
      return await replay.poll(deviceId, params, abort.signal)
    } catch (error) {
      throw context.error('conflict', error instanceof Error ? error.message : 'notification polling failed')
    } finally {
      unsubscribeClose()
    }
  })
  context.provide('method:quirky.mobile/notificationTest', () => {
    replay.append({ title: 'Quirky mobile test notification', body: 'Your direct phone notification subscription is working.' }, true)
    return { sent: true }
  })
  return () => {
    stopped = true
    unsubscribe()
    replay.dispose()
  }
}
