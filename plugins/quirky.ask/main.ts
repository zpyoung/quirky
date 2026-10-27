import type { Ask, PluginCaller, PluginContext, UiState } from '@quirky/protocol'
import { AskService } from './asks'
import { askQueueMigration } from './store-migrations'
import { ClaudeVersionGate, commandProbe, suppressionHook } from './suppression'
import { v1AsksMigration } from './v1-import'

const QUESTIONS_PANEL = 'panel:quirky.ask/questions'

function str(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name]
  return typeof value === 'string' ? value : undefined
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

function announce(context: PluginContext, ask: Ask): void {
  context.notify({
    title: ask.spec.title ?? 'Question',
    body: ask.spec.questions[0].question,
    ...(ask.sessionId !== null ? { sessionId: ask.sessionId } : {}),
    ...(ask.worktreeId !== null ? { worktreeId: ask.worktreeId } : {})
  })
}

let service: AskService | undefined

/** Provides the ask methods, the deadline job and the Claude launch hook; the CLI commands and the panel's window module live elsewhere. */
export function activate(context: PluginContext): void {
  const store = context.openStore([v1AsksMigration(context.home), askQueueMigration])
  const asks = new AskService(
    store,
    {
      invalidParams: (message) => context.error('invalid-params', message),
      notFound: (message) => context.error('not-found', message),
      conflict: (message) => context.error('conflict', message)
    },
    {
      created: (ask, seq) => {
        context.emit('created', { ask, seq })
        if (!ask.queued && asks.get(ask.id).envelope.status === 'pending') announce(context, ask)
      },
      surfaced: (ask, seq) => {
        context.emit('surfaced', { ask, seq })
        announce(context, ask)
        void openQuestionsPanel(context)
      },
      updated: (askId, partial, seq) => void context.emit('updated', { askId, partial, seq }),
      resolved: (askId, envelope, seq) => void context.emit('resolved', { askId, envelope, seq })
    }
  )

  service = asks

  context.provide('method:quirky.ask/create', async (params: Record<string, unknown>, caller: PluginCaller) => {
    const client = caller.role === 'plugin' ? undefined : caller
    const ask = asks.create(
      params.spec,
      str(params, 'session') ?? client?.sessionId ?? null,
      str(params, 'worktree') ?? client?.worktreeId ?? null,
      {
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        checkCredentialText: caller.role !== 'plugin'
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

  asks.start()
}

/** Rejects pending waits and clears their timers so nothing touches the store once the host closes it. */
export function deactivate(): void {
  service?.shutdown()
  service = undefined
}
