import type { PluginContext } from '@quirky/protocol'

type PreparationCall = Record<string, unknown>

declare global {
  var __FAKE_ACCOUNT_PREPARATION_CALLS__: PreparationCall[] | undefined
}

export function fakeAccountPreparationCalls(): PreparationCall[] {
  globalThis.__FAKE_ACCOUNT_PREPARATION_CALLS__ ??= []
  return globalThis.__FAKE_ACCOUNT_PREPARATION_CALLS__
}

export function resetFakeAccountPreparation(): void {
  globalThis.__FAKE_ACCOUNT_PREPARATION_CALLS__ = []
}

export function activate(context: PluginContext): void {
  context.provide('method:quirky.accounts/prepare', (params: Record<string, unknown>) => {
    fakeAccountPreparationCalls().push(params)
    return { env: params.agent === 'codex' ? { CODEX_HOME: '/account/codex-home' } : {}, shellInit: null, account: null }
  })
}
