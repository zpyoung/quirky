import {
  CONNECTION_METHODS,
  KERNEL_METHOD_SCHEMAS,
  parseContributionId,
  RpcErrorCode,
  validateValue,
  type ClientRole,
  type MethodHandler,
  type PluginCaller,
  type Schema
} from '@quirky/protocol'
import { DaemonError, internal, invalidParams } from '../errors'
import type { Handlers } from '../methods'
import type { ClientConn } from '../types'
import type { PluginHost } from './host'

export type DispatchSource = { conn: ClientConn } | { pluginId: string }

const unknownMethod = (method: string) => new DaemonError(RpcErrorCode.MethodNotFound, `unknown method: ${method}`)

function detachedConn(): ClientConn {
  return { id: 0, role: null, subscribed: false, closed: true, streams: new Map(), nextStreamId: 1, sendText() {}, sendBinary() {} }
}

/**
 * Routes one method call, from a client connection or from a plugin, to a kernel handler or to a
 * plugin's `method:` contribution. Plugin code is activated only for a method that is in effect.
 */
export class Dispatcher {
  constructor(
    private readonly handlers: Handlers,
    private readonly plugins: PluginHost,
    private readonly log: (message: string) => void
  ) {}

  /**
   * Runs `method` and returns its result (`null` for `undefined`). Rejects MethodNotFound for an
   * unknown or disabled name, InvalidParams for a connection method called from a plugin and for
   * params that fail the method's schema (before any plugin activates); a
   * `DaemonError` from the handler passes through and anything else becomes Internal.
   */
  async dispatch(method: string, params: Record<string, unknown>, from: DispatchSource): Promise<unknown> {
    // awaited so a params failure thrown before the handler's first await is handled in the same tick
    if (Object.hasOwn(this.handlers, method)) return await this.runKernel(method, params, from)
    if (!method.includes('/')) throw unknownMethod(method)

    const id = `method:${method}`
    const effective = parseContributionId(id)
      ? this.plugins.contributions({ kind: 'method' }).find((contribution) => contribution.id === id)
      : undefined
    if (!effective) throw unknownMethod(method)

    const declared = (effective.data as { params?: Schema }).params
    const failure = validateValue(declared ?? { type: 'object' }, params)
    if (failure) throw invalidParams(failure)

    const implementation = (await this.plugins.resolveImplementation(id)) as MethodHandler
    const caller = callerOf(from)
    try {
      return (await implementation(params, caller)) ?? null
    } catch (error) {
      if (error instanceof DaemonError) throw error
      this.log(`method ${method} failed in ${effective.plugin}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      throw internal(`${effective.plugin}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async runKernel(method: string, params: Record<string, unknown>, from: DispatchSource): Promise<unknown> {
    let conn: ClientConn
    if ('conn' in from) {
      conn = from.conn
    } else {
      if ((CONNECTION_METHODS as readonly string[]).includes(method)) throw invalidParams(`${method} needs a client connection`)
      conn = detachedConn()
    }
    const failure = validateValue(KERNEL_METHOD_SCHEMAS[method as keyof typeof KERNEL_METHOD_SCHEMAS].params, params)
    if (failure) throw invalidParams(failure)
    const handler = (this.handlers as Record<string, (params: Record<string, unknown>, conn: ClientConn) => unknown>)[method]!
    return (await handler(params, conn)) ?? null
  }
}

function callerOf(from: DispatchSource): PluginCaller {
  if ('pluginId' in from) return { role: 'plugin', pluginId: from.pluginId }
  const { role, name } = from.conn
  return name === undefined ? { role: role as ClientRole } : { role: role as ClientRole, name }
}
