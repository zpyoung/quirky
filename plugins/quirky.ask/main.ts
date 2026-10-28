import type { PluginCaller, PluginContext, PluginErrorKind, PluginInfo, UiState } from '@quirky/protocol'
import { AskService } from './asks'
import { askOwnershipMigration, askQueueMigration } from './store-migrations'
import { ClaudeVersionGate, commandProbe, suppressionHook } from './suppression'
import { v1AsksMigration } from './v1-import'

const QUESTIONS_PANEL = 'panel:quirky.ask/questions'

function str(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name]
  return typeof value === 'string' ? value : undefined
}


function logSafely(context: PluginContext, message: string): void {
  try {
    context.log(message)
  } catch {
    // The host revokes plugin contexts before calling deactivate.
  }
}

function errorSafely(context: PluginContext, kind: PluginErrorKind, message: string): Error {
  try {
    return context.error(kind, message)
  } catch {
    return new Error(message)
  }
}

function emitSafely(context: PluginContext, event: string, data: unknown): void {
  try {
    context.emit(event, data)
  } catch {
    // Revoked plugin contexts can't emit; ask-store mutations must still complete.
  }
}

async function cancelInactiveOwners(context: PluginContext, asks: AskService): Promise<void> {
  try {
    const plugins = (await context.call('plugin.list')) as PluginInfo[]
    const activePluginIds = new Set(plugins.filter((plugin) => plugin.state === 'active').map((plugin) => plugin.id))
    if (service === asks) asks.cancelOwnedByInactivePlugins(activePluginIds)
  } catch (error) {
    logSafely(context, `could not reconcile plugin-owned asks: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Opens the Questions panel when a window is connected and no panel is showing; never throws. */
async function openQuestionsPanel(context: PluginContext): Promise<void> {
  try {
    const state = (await context.call('ui.state')) as UiState
    if (state.windows.length > 0 && state.layout.panel === null) {
      await context.call('ui.panel.open', { id: QUESTIONS_PANEL })
    }
  } catch (error) {
    context.log(`could not open the Questions panel: ${error instanceof Error ? error.message : String(error)}`)
  }
}

let service: AskService | undefined

/** Provides the ask methods, the deadline job and the Claude launch hook; the CLI commands and the panel's window module live elsewhere. */
export function activate(context: PluginContext): void {
  const store = context.openStore([v1AsksMigration(context.home), askQueueMigration, askOwnershipMigration])
  const asks = new AskService(
    store,
    {
      invalidParams: (message) => errorSafely(context, 'invalid-params', message),
      notFound: (message) => errorSafely(context, 'not-found', message),
      conflict: (message) => errorSafely(context, 'conflict', message)
    },
    {
      created: (ask, seq) => emitSafely(context, 'created', { ask, seq }),
      surfaced: (ask, seq) => {
        emitSafely(context, 'surfaced', { ask, seq })
        void openQuestionsPanel(context)
      },
      updated: (askId, partial, seq) => emitSafely(context, 'updated', { askId, partial, seq }),
      resolved: (askId, envelope, seq) => emitSafely(context, 'resolved', { askId, envelope, seq })
    }
  )

  service = asks
  context.subscribe((event) => {
    if (event.type === 'plugin.changed') void cancelInactiveOwners(context, asks)
  })

  context.provide('method:quirky.ask/create', async (params: Record<string, unknown>, caller: PluginCaller) => {
    const client = caller.role === 'plugin' ? undefined : caller

    // Kernel confirmations also use role "plugin", but have no lifecycle-owned registry entry.
    let ownerPluginId: string | undefined
    if (caller.role === 'plugin') {
      const plugins = (await context.call('plugin.list')) as PluginInfo[]
      if (plugins.some((plugin) => plugin.id === caller.pluginId)) ownerPluginId = caller.pluginId
    }
    const ask = asks.create(
      params.spec,
      str(params, 'session') ?? client?.sessionId ?? null,
      str(params, 'worktree') ?? client?.worktreeId ?? null,
      {
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        checkCredentialText: caller.role !== 'plugin',
        ...(ownerPluginId === undefined ? {} : { ownerPluginId })
      }
    )
    if (!ask.queued && ask.envelope.status === 'pending') await openQuestionsPanel(context)
    return { askId: ask.id }
  })
  context.provide('method:quirky.ask/wait', (params: Record<string, unknown>) =>
    asks.wait(str(params, 'askId')!, typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined)
  )
  context.provide('method:quirky.ask/answer', (params: Record<string, unknown>) =>
    asks.answer(str(params, 'askId')!, params.answers, params.skipped)
  )
  context.provide('method:quirky.ask/cancel', (params: Record<string, unknown>) => asks.cancel(str(params, 'askId')!))
  context.provide('method:quirky.ask/list', (params: Record<string, unknown>) => asks.list(params.pendingOnly === true))
  context.provide('method:quirky.ask/updatePartial', (params: Record<string, unknown>) =>
    asks.updatePartial(str(params, 'askId')!, params.partial)
  )
  context.provide('method:quirky.ask/expire', (params: Record<string, unknown>) => asks.expire(str(params, 'askId')!))
  context.provide('job:quirky.ask/deadlines', () => asks.sweep())
  context.provide('launch-hook:quirky.ask/claude-ask', suppressionHook(context, new ClaudeVersionGate(commandProbe(context), Date.now)))

  asks.cancelPluginOwned()
  asks.start()
}

/** Cancels plugin-owned asks while the store is open, then rejects remaining waits and clears timers. */
export function deactivate(): void {
  const asks = service
  if (!asks) return
  try {
    asks.cancelPluginOwned()
  } finally {
    asks.shutdown()
    if (service === asks) service = undefined
  }
}
