import type { PluginCaller, PluginContext } from '@quirky/protocol'
import {
  decide,
  pace,
  resolveOutcome,
  stop,
  type Attempt,
  type CapabilityMode,
  type JournalEntry,
  type SitterAction,
  type SitterPayload,
  type SitterWorld,
  type Snapshot
} from './src/policy'
import {
  preflight,
  assertHeimdallCaller,
  authorize,
  execute,
  read,
  SITTER_PAYLOAD_SCHEMA,
  type Call
} from './src/github'

const HOOKS = {
  authorize: 'quirky.sitter/authorize',
  read: 'quirky.sitter/read',
  decide: 'quirky.sitter/decide',
  execute: 'quirky.sitter/execute',
  resolveOutcome: 'quirky.sitter/resolveOutcome',
  pace: 'quirky.sitter/pace',
  stop: 'quirky.sitter/stop',
  preflight: 'quirky.sitter/preflight'
} as const

type SitterEnrollment = { capabilities: Record<string, CapabilityMode>; kindPayload: SitterPayload }

export async function activate(context: PluginContext): Promise<void> {
  const processRun: PluginContext['process']['run'] = (argv, options) => context.process.run(argv, options)
  const call: Call = (method, params) => context.call(method, params)
  const assertCaller = (caller: PluginCaller) => {
    try {
      assertHeimdallCaller(caller)
    } catch (error) {
      throw context.error('invalid-params', error instanceof Error ? error.message : String(error))
    }
  }

  context.provide('method:quirky.sitter/authorize', (params: Record<string, unknown>, caller: PluginCaller) => {
    assertCaller(caller)
    return authorize(call, params.input as Parameters<typeof authorize>[1])
  })
  context.provide('method:quirky.sitter/read', (params: Record<string, unknown>, caller: PluginCaller) => {
    assertCaller(caller)
    return read(call, params.enrollment as Parameters<typeof read>[1], processRun)
  })
  context.provide('method:quirky.sitter/decide', (params: Record<string, unknown>, caller: PluginCaller) => {
    assertCaller(caller)
    return decide(
      params.snapshot as Snapshot<SitterWorld>,
      params.journal as JournalEntry[],
      params.enrollment as SitterEnrollment
    )
  })
  context.provide('method:quirky.sitter/execute', (params: Record<string, unknown>, caller: PluginCaller) => {
    assertCaller(caller)
    return execute(
      call,
      params.action as SitterAction,
      params.enrollment as Parameters<typeof execute>[2],
      undefined,
      {
        processRun,
        fingerprint: typeof params.fingerprint === 'string' ? params.fingerprint : ''
      }
    )
  })
  context.provide('method:quirky.sitter/preflight', (params: Record<string, unknown>, caller: PluginCaller) => {
    assertCaller(caller)
    return preflight(call, params as Parameters<typeof preflight>[1], processRun)
  })
  context.provide('method:quirky.sitter/resolveOutcome', (params: Record<string, unknown>, caller: PluginCaller) => {
    assertCaller(caller)
    return resolveOutcome(params.attempt as Attempt, params.snapshot as Snapshot<SitterWorld>)
  })
  context.provide('method:quirky.sitter/pace', (params: Record<string, unknown>, caller: PluginCaller) => {
    assertCaller(caller)
    return pace(params.snapshot as Snapshot<SitterWorld>, params.journal as JournalEntry[])
  })
  context.provide('method:quirky.sitter/stop', (params: Record<string, unknown>, caller: PluginCaller) => {
    assertCaller(caller)
    return stop(
      params.snapshot as Snapshot<SitterWorld>,
      params.journal as JournalEntry[],
      params.enrollment as SitterEnrollment
    )
  })

  try {
    await context.call('quirky.heimdall/registerKind', {
      id: 'hosted-review',
      displayName: 'PR sitter',
      enrollmentPayloadSchema: SITTER_PAYLOAD_SCHEMA,
      hooks: HOOKS
    })
  } catch (error) {
    context.log(`hosted-review kind was not registered: ${error instanceof Error ? error.message : String(error)}`)
  }
}
