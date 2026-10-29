import type { Ask, AskAnswer, AskSpec, PluginContext } from '@quirky/protocol'

export type FakeAsk = {
  spec: AskSpec
  status: 'pending' | 'answered' | 'declined'
  value?: boolean
  sessionId: string | null
  worktreeId: string | null
  createdAt: number
  seq: number
}

declare global {
  var __FAKE_ASKS__: Map<string, FakeAsk> | undefined
}

/** Test handle on the fake's asks; the daemon runs in the test process so the global is shared. */
export function fakeAsks(): Map<string, FakeAsk> {
  globalThis.__FAKE_ASKS__ ??= new Map()
  return globalThis.__FAKE_ASKS__
}

export function activate(context: PluginContext): void {
  context.provide('method:quirky.ask/create', (params: { spec: AskSpec; session?: string; worktree?: string }) => {
    const asks = fakeAsks()
    const askId = `ask_${asks.size + 1}`
    asks.set(askId, {
      spec: params.spec,
      status: 'pending',
      sessionId: params.session ?? null,
      worktreeId: params.worktree ?? null,
      createdAt: Date.now(),
      seq: asks.size + 1
    })
    return { askId }
  })
  context.provide('method:quirky.ask/wait', async (params: { askId: string }) => {
    const ask = fakeAsks().get(params.askId)
    if (ask?.status === 'pending') await Bun.sleep(50)
    const answered = ask?.status === 'answered'
    return {
      status: ask?.status ?? 'declined',
      askId: params.askId,
      answers: answered ? { confirm: { value: ask!.value, source: 'input' } } : {},
      skipped: []
    }
  })
  context.provide('method:quirky.ask/list', (params: { pendingOnly?: boolean; askId?: string }) => {
    return [...fakeAsks()]
      .filter(([askId, ask]) =>
        (params.askId === undefined || askId === params.askId) &&
        (params.pendingOnly !== true || ask.status === 'pending')
      )
      .map(([askId, ask]): Ask => {
        const answers: Record<string, AskAnswer> = ask.status === 'answered'
          ? { confirm: { value: ask.value === true, source: 'input' } }
          : {}
        const skipped = ask.status === 'declined'
          ? ask.spec.questions.map((question) => question.id)
          : []
        return {
          id: askId,
          spec: ask.spec,
          sessionId: ask.sessionId,
          worktreeId: ask.worktreeId,
          createdAt: ask.createdAt,
          envelope: { askId, status: ask.status, answers, skipped, summary: '' },
          seq: ask.seq,
          queued: false,
          partial: {},
          expiresAt: null
        }
      })
  })
}
