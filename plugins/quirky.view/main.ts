import type { PluginCaller, PluginContext, PluginErrorKind } from '@quirky/protocol'
import { viewsMigration, viewVersionsMigration, ViewStore } from './src/core/store'
import { MAX_WAIT_MS, ViewService } from './src/core/views'

const NO_SESSION = 'quirky view works only inside a Quirky agent session'

function str(params: Record<string, unknown>, name: string): string {
  const value = params[name]
  if (typeof value !== 'string' || value === '') throw new Error(`${name} must be a non-empty string`)
  return value
}

/** The live session behind a caller, or undefined for a caller with no kernel-attested session authority. */
function sessionOf(caller: PluginCaller): string | undefined {
  if (caller.role === 'plugin' || !caller.sessionAuthority) return undefined
  const identity = caller.sessionAuthority
  if (caller.sessionId !== identity.sessionId || identity.live !== true) return undefined
  return identity.sessionId
}

function isWindow(caller: PluginCaller): boolean {
  return (caller.role === 'ui' || caller.role === 'desktop') && caller.sessionId === undefined && caller.sessionAuthority === undefined
}

function logSafely(context: PluginContext, message: string): void {
  try {
    context.log(message)
  } catch {
    // the host revokes plugin contexts before calling deactivate
  }
}

let service: ViewService | undefined

/** Provides the view methods and emits `changed` and `rejected` for the session journal and the window. */
export function activate(context: PluginContext): void {
  const error = (kind: PluginErrorKind) => (message: string) => context.error(kind, message)
  const views = new ViewService(new ViewStore(context.openStore([viewsMigration, viewVersionsMigration])), {
    emit(event, data) {
      try {
        context.emit(event, data)
      } catch (cause) {
        logSafely(context, `could not emit ${event}: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    },
    send: (sessionId, text) => context.call('quirky.structured/send', { session: sessionId, text, when: 'idle' }),
    invalidParams: error('invalid-params'),
    notFound: error('not-found'),
    conflict: error('conflict')
  })
  service = views

  const required = (params: Record<string, unknown>, name: string): string => {
    try {
      return str(params, name)
    } catch (cause) {
      throw context.error('invalid-params', (cause as Error).message)
    }
  }
  const agentSession = (caller: PluginCaller): string => {
    const sessionId = sessionOf(caller)
    if (sessionId === undefined) throw context.error('conflict', NO_SESSION)
    return sessionId
  }
  const windowOnly = (caller: PluginCaller, method: string): void => {
    if (!isWindow(caller)) throw context.error('conflict', `${method} is available to the window only`)
  }
  const readable = (caller: PluginCaller, sessionId: string): void => {
    if (caller.role === 'plugin' || isWindow(caller) || sessionOf(caller) === sessionId) return
    throw context.error('conflict', 'views can be read by the window or by their own session only')
  }
  const specOf = (params: Record<string, unknown>): unknown => {
    if (params.spec === undefined) throw context.error('invalid-params', 'spec is required')
    return params.spec
  }

  context.provide('method:quirky.view/open', (params: Record<string, unknown>, caller: PluginCaller) =>
    views.open(agentSession(caller), specOf(params), params.placement)
  )
  context.provide('method:quirky.view/update', (params: Record<string, unknown>, caller: PluginCaller) => {
    const sessionId = agentSession(caller)
    views.update(sessionId, required(params, 'viewId'), specOf(params))
    return { ok: true }
  })
  context.provide('method:quirky.view/patch', (params: Record<string, unknown>, caller: PluginCaller) => {
    const sessionId = agentSession(caller)
    if (params.ops === undefined) throw context.error('invalid-params', 'ops is required')
    return views.patch(sessionId, required(params, 'viewId'), params.ops)
  })
  context.provide('method:quirky.view/close', (params: Record<string, unknown>, caller: PluginCaller) => {
    const sessionId = agentSession(caller)
    views.close(sessionId, required(params, 'viewId'))
    return { ok: true }
  })
  context.provide('method:quirky.view/wait', async (params: Record<string, unknown>, caller: PluginCaller) => {
    const sessionId = agentSession(caller)
    const timeoutMs = params.timeoutMs
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 0)) {
      throw context.error('invalid-params', `timeoutMs must be an integer between 0 and ${MAX_WAIT_MS}`)
    }
    const controller = new AbortController()
    const unsubscribe = caller.role === 'plugin' ? undefined : caller.connection?.onClose(() => controller.abort())
    try {
      return await views.wait(sessionId, required(params, 'viewId'), timeoutMs, controller.signal)
    } finally {
      unsubscribe?.()
    }
  })
  context.provide('method:quirky.view/list', (params: Record<string, unknown>, caller: PluginCaller) => {
    const sessionId = required(params, 'session')
    readable(caller, sessionId)
    return views.list(sessionId)
  })
  context.provide('method:quirky.view/get', (params: Record<string, unknown>, caller: PluginCaller) => {
    const viewId = required(params, 'viewId')
    const version = params.version
    if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version) || version < 1)) {
      throw context.error('invalid-params', 'version must be a positive integer')
    }
    const latest = views.get(viewId)
    readable(caller, latest.sessionId)
    return version === undefined ? latest : views.get(viewId, version)
  })
  context.provide('method:quirky.view/move', (params: Record<string, unknown>, caller: PluginCaller) => {
    windowOnly(caller, 'move')
    return views.move(required(params, 'viewId'), params.placement)
  })
  context.provide('method:quirky.view/render-failed', (params: Record<string, unknown>, caller: PluginCaller) => {
    windowOnly(caller, 'render-failed')
    return views.renderFailed(required(params, 'viewId'), params.version, params.error)
  })
  context.provide('method:quirky.view/action', (params: Record<string, unknown>, caller: PluginCaller) => {
    windowOnly(caller, 'action')
    return views.action(required(params, 'viewId'), params.name, params.source, params.data)
  })
}

/** Releases parked waits; stored views stay. */
export function deactivate(): void {
  const views = service
  service = undefined
  views?.shutdown()
}
