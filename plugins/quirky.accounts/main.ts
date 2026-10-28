import type { PluginContext } from '@quirky/protocol'
import { AccountService } from './src/service'
import { migrations } from './src/store'
import { UsageService } from './src/usage/index'

let activeService: AccountService | undefined

export function activate(context: PluginContext): void {
  const store = context.openStore(migrations)
  const accounts = new AccountService(context, store)
  const usage = new UsageService(context, () => accounts.usageTargets())
  accounts.attachUsageService(usage)
  activeService = accounts

  const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
    list: (params) => accounts.list(params),
    usage: () => accounts.usage(),
    refresh: (params) => accounts.refresh(params),
    inactiveUsage: (params) => accounts.inactiveUsage(params),
    beginLogin: (params) => accounts.beginLogin(params),
    loginStatus: (params) => accounts.loginStatus(params),
    sessionHome: (params) => accounts.sessionHome(params),
    cancelLogin: (params) => accounts.cancelLogin(params),
    select: (params) => accounts.select(params),
    remove: (params) => accounts.remove(params),
    describeRemove: (params) => accounts.describeRemove(params),
    setPreferences: (params) => accounts.setPreferences(params),
    uiState: () => accounts.uiState(),
    setUiState: (params) => accounts.setUiState(params),
    prepare: (params) => accounts.prepare(params),
    prepareProviderEnv: (params) => accounts.prepareProviderEnv(params),
    restart: (params) => accounts.restart(params),
    keep: (params) => accounts.keep(params),
    ingestClaude: (params) => accounts.ingestClaude(params),
    credentialStatus: () => accounts.credentialStatus(),
    setCredential: (params) => accounts.setCredential(params),
    clearCredential: (params) => accounts.clearCredential(params),
    describeReset: (params) => accounts.describeReset(params),
    consumeResetCredit: (params) => accounts.consumeResetCredit(params)
  }
  for (const [name, handler] of Object.entries(methods)) {
    context.provide(`method:${context.pluginId}/${name}`, handler)
  }
  context.provide(`job:${context.pluginId}/usage-refresh`, async ({ signal }: { jobId: string; signal: AbortSignal }) => {
    if (!signal.aborted) await accounts.backgroundUsageRefresh()
  })
  context.subscribe((event) => accounts.onEvent(event))
  accounts.start()
}

export async function deactivate(): Promise<void> {
  const current = activeService
  activeService = undefined
  await current?.shutdown()
}
