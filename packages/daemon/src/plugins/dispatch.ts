import {
  CONNECTION_METHODS,
  KERNEL_METHOD_SCHEMAS,
  parseContributionId,
  RpcErrorCode,
  validateValue,
  type ClientRole,
  type KernelMethodSchema,
  type MethodHandler,
  type PluginCaller,
  type PluginSessionAuthority,
  type Schema
} from '@quirky/protocol'
import { DaemonError, conflict, internal, invalidParams, unauthorized } from '../errors'
import type { Handlers } from '../methods'
import { Store } from '../store'
import type { ClientConn } from '../types'
import { Confirmations, type ConfirmStore, type ConfirmTarget, type KernelDescriber } from './confirm'
import type { PluginHost } from './host'
import { RequestLog, requestDigest, type RequestStore } from './requests'
import { onConnectionClose, openStream } from './streams'

/**
 * Where a call comes from: a client connection, a plugin, or the kernel itself. Kernel calls are
 * never recorded or confirmed and run with the caller `{ role: 'plugin', pluginId: 'kernel' }`.
 */
export type DispatchSource = { conn: ClientConn } | { pluginId: string } | { kernel: true }
type ForwardingBinding = { pluginId: string; source: DispatchSource; active: boolean }

/** What the dispatcher needs from the plugin host. */
export type DispatchHost = Pick<PluginHost, 'contributions' | 'resolveImplementation'>

export type DispatchOptions = {
  /** Makes a call from a connection idempotent; see `RequestLog`. */
  requestId?: string
}

export type DispatcherOptions = {
  /** Where request IDs and confirmations are recorded; defaults to a private in-memory store. */
  store?: RequestStore & ConfirmStore
  /**
   * Action text for destructive kernel methods whose confirmation lists more than the `confirm`
   * text, keyed by method name. The describer returns the whole text.
   */
  kernelDescribers?: Record<string, KernelDescriber>
  now?: () => number
  /** Revalidates connection session credentials before every plugin method call. */
  resolveSessionAuthority?: (conn: ClientConn) => Promise<PluginSessionAuthority | null>
}

const KERNEL_PLUGIN_ID = 'kernel'

const unknownMethod = (method: string) => new DaemonError(RpcErrorCode.MethodNotFound, `unknown method: ${method}`)

type Target = {
  name: string
  kernel: boolean
  params: Schema
  readOnly: boolean
  connection: boolean
  destructive?: ConfirmTarget
  /** The `method:` contribution ID and declaring plugin of a plugin method. */
  contribution?: { id: string; plugin: string }
}

function detachedConn(): ClientConn {
  return {
    id: 0,
    role: null,
    transport: 'websocket',
    subscribed: false,
    closed: true,
    streams: new Map(),
    streamClosers: new Map(),
    nextStreamId: 1,
    sendText() {},
    sendBinary() {}
  }
}

/**
 * Routes one method call, from a client connection, a plugin or the kernel, to a kernel handler or
 * to a plugin's `method:` contribution. Plugin code is activated only for a method that is in
 * effect, after its params validate.
 */
export class Dispatcher {
  private readonly requests: RequestLog
  private readonly confirmations: Confirmations
  private readonly kernelDescribers: Record<string, KernelDescriber>
  private readonly resolveSessionAuthority?: DispatcherOptions['resolveSessionAuthority']
  private readonly forwardedCallers = new WeakMap<PluginCaller, ForwardingBinding>()

  constructor(
    private readonly handlers: Handlers,
    private readonly plugins: DispatchHost,
    private readonly log: (message: string) => void,
    options: DispatcherOptions = {}
  ) {
    const store = options.store ?? new Store(':memory:')
    this.kernelDescribers = options.kernelDescribers ?? {}
    this.resolveSessionAuthority = options.resolveSessionAuthority
    this.requests = new RequestLog(store, { now: options.now, log })
    this.confirmations = new Confirmations(store, (method, params, from) => this.dispatch(method, params, from), {
      now: options.now,
      log
    })
  }
  /** Dispatches with the exact client source bound to a caller from this plugin's active handler. */
  forward(pluginId: string, method: string, params: Record<string, unknown>, caller: PluginCaller): Promise<unknown> {
    const binding = this.forwardedCallers.get(caller)
    if (!binding || binding.pluginId !== pluginId || !binding.active || !('conn' in binding.source)) {
      throw conflict('forwarding caller is no longer active')
    }
    return this.dispatch(method, params, binding.source)
  }


  /**
   * Runs `method` and returns its result (`null` for `undefined`). Rejects MethodNotFound for an
   * unknown or disabled name, InvalidParams for a connection method called without a connection
   * and for params that fail the method's schema (before any plugin activates). A destructive
   * method needs `yes: true` or the `confirmation` of an answered ask, else it rejects
   * ConfirmationRequired. With `options.requestId`, a call from a connection to a method that is
   * neither read-only nor a connection method returns its first outcome when repeated. A
   * `DaemonError` from the handler passes through and anything else becomes Internal.
   */
  async dispatch(
    method: string,
    params: Record<string, unknown>,
    from: DispatchSource,
    options: DispatchOptions = {}
  ): Promise<unknown> {
    if ('conn' in from && from.conn.authorize) {
      try {
        await from.conn.authorize(method, params)
      } catch {
        throw unauthorized()
      }
      if (from.conn.closed) throw unauthorized()
    }
    const target = this.find(method)
    if (target.connection && !('conn' in from)) throw invalidParams(`${method} needs a client connection`)

    let callParams = params
    let yes: unknown
    let confirmation: unknown
    if (target.destructive) {
      ;({ yes, confirmation, ...callParams } = params)
      if (yes !== undefined && typeof yes !== 'boolean') throw invalidParams('yes must be a boolean')
      if (confirmation !== undefined && typeof confirmation !== 'string') throw invalidParams('confirmation must be a string')
    }
    const failure = validateValue(target.params, callParams)
    if (failure) throw invalidParams(failure)

    const run = () => this.confirmAndRun(target, callParams, from, yes === true, confirmation as string | undefined)
    if ('conn' in from && options.requestId !== undefined && !target.readOnly && !target.connection) {
      return await this.requests.run(options.requestId, requestDigest(method, callParams), run)
    }
    return await run()
  }

  private find(method: string): Target {
    if (Object.hasOwn(this.handlers, method)) {
      const entry = (KERNEL_METHOD_SCHEMAS as Record<string, KernelMethodSchema>)[method]
      return {
        name: method,
        kernel: true,
        params: entry.params,
        readOnly: entry.readOnly === true,
        connection: (CONNECTION_METHODS as readonly string[]).includes(method),
        ...(entry.destructive
          ? {
              destructive: {
                method,
                confirm: entry.destructive.confirm,
                ...(Object.hasOwn(this.kernelDescribers, method) ? { describeWith: this.kernelDescribers[method] } : {})
              }
            }
          : {})
      }
    }
    if (!method.includes('/')) throw unknownMethod(method)

    const id = `method:${method}`
    const effective = parseContributionId(id)
      ? this.plugins.contributions({ kind: 'method' }).find((contribution) => contribution.id === id)
      : undefined
    if (!effective) throw unknownMethod(method)

    const data = effective.data as { params?: Schema; readOnly?: unknown; connection?: unknown; destructive?: unknown; confirm?: unknown; describe?: unknown }
    const describe = typeof data.describe === 'string' ? (data.describe.includes('/') ? data.describe : `${effective.plugin}/${data.describe}`) : undefined
    return {
      name: method,
      kernel: false,
      params: data.params ?? { type: 'object' },
      readOnly: data.readOnly === true,
      connection: data.connection === true,
      contribution: { id, plugin: effective.plugin },
      ...(data.destructive === true
        ? { destructive: { method, confirm: typeof data.confirm === 'string' ? data.confirm : `Run ${method}?`, ...(describe ? { describe } : {}) } }
        : {})
    }
  }

  private async confirmAndRun(
    target: Target,
    params: Record<string, unknown>,
    from: DispatchSource,
    yes: boolean,
    confirmation: string | undefined
  ): Promise<unknown> {
    if (target.destructive && !yes && !('kernel' in from)) {
      if (confirmation !== undefined) this.confirmations.assertUnused(confirmation)
      const prepared = await this.confirmations.prepare(target.destructive, params, from)
      if (prepared) {
        if (confirmation === undefined) await this.confirmations.request(target.name, prepared, from)
        else await this.confirmations.consume(confirmation, target.name, prepared.digest)
      }
    }
    return (await this.invoke(target, params, from)) ?? null
  }

  private async invoke(target: Target, params: Record<string, unknown>, from: DispatchSource): Promise<unknown> {
    if (target.kernel) {
      const handler = (this.handlers as Record<string, (params: Record<string, unknown>, conn: ClientConn) => unknown>)[target.name]!
      return await handler(params, 'conn' in from ? from.conn : detachedConn())
    }
    const { id, plugin } = target.contribution!
    const implementation = (await this.plugins.resolveImplementation(id)) as MethodHandler
    const sessionAuthority = 'conn' in from ? await this.resolveSessionAuthority?.(from.conn) : undefined
    const caller = callerOf(from, target.connection, sessionAuthority ?? undefined)
    const binding = { pluginId: plugin, source: from, active: true }
    this.forwardedCallers.set(caller, binding)
    try {
      return await implementation(params, caller)
    } catch (error) {
      if (error instanceof DaemonError) throw error
      this.log(`method ${target.name} failed in ${plugin}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      throw internal(`${plugin}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      binding.active = false
      this.forwardedCallers.delete(caller)
    }
  }
}

function callerOf(from: DispatchSource, withConnection: boolean, sessionAuthority?: PluginSessionAuthority): PluginCaller {
  if ('pluginId' in from) return { role: 'plugin', pluginId: from.pluginId }
  if ('kernel' in from) return { role: 'plugin', pluginId: KERNEL_PLUGIN_ID }
  const { role, name, deviceId, cwd, sessionId, worktreeId } = from.conn
  return {
    role: role as ClientRole,
    ...(name !== undefined ? { name } : {}),
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(worktreeId !== undefined ? { worktreeId } : {}),
    ...(sessionAuthority !== undefined ? { sessionAuthority } : {}),
    ...(withConnection || role === 'mobile'
      ? { connection: { id: from.conn.id, transport: from.conn.transport, onClose: (callback) => onConnectionClose(from.conn, callback), openStream: () => openStream(from.conn) } }
      : {})
  }
}
