import type { PluginPty } from '@quirky/protocol'
import { internal } from '../errors'
import type { PtyClient } from '../pty-client'

/** Builds `context.pty` for one plugin over the shared PTY client; `revoke` removes the plugin's listeners. */
export function createPtyApi(_pty: PtyClient, _pluginId: string): { api: PluginPty; revoke(): void } {
  const unavailable = (name: string) => () => {
    throw internal(`not implemented: pty.${name}`)
  }
  const api: PluginPty = {
    get connected(): boolean {
      throw internal('not implemented: pty.connected')
    },
    spawn: unavailable('spawn'),
    write: unavailable('write'),
    resize: unavailable('resize'),
    read: unavailable('read'),
    kill: unavailable('kill'),
    forget: unavailable('forget'),
    list: unavailable('list'),
    subscribe: unavailable('subscribe'),
    unsubscribe: unavailable('unsubscribe'),
    onData: unavailable('onData'),
    onExit: unavailable('onExit'),
    onReconnect: unavailable('onReconnect')
  }
  return { api, revoke() {} }
}
