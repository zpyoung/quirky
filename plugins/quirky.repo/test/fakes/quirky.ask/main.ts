export type FakeAsk = { spec: any; status: 'pending' | 'answered' | 'declined'; value?: boolean }

declare global {
  var __FAKE_ASKS__: Map<string, FakeAsk> | undefined
}

/** Test handle on the fake's asks; the daemon runs in the test process so the global is shared. */
export function fakeAsks(): Map<string, FakeAsk> {
  globalThis.__FAKE_ASKS__ ??= new Map()
  return globalThis.__FAKE_ASKS__
}

export function activate(context: any): void {
  context.provide('method:quirky.ask/create', (params: { spec: any }) => {
    const asks = fakeAsks()
    const askId = `ask_${asks.size + 1}`
    asks.set(askId, { spec: params.spec, status: 'pending' })
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
}
