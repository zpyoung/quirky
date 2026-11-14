import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { AccountsSettings } from './window/AccountsSettings'
import { AccountSwitchDialog, SessionAccessory, StatusBarUsage } from './window/Usage'
import { AccountsUiStore, COPY_LOGIN_LINK_COMMAND_ID, PROVIDERS, REFRESH_COMMAND_ID, SELECT_ACCOUNT_COMMAND_ID, type ManagedProvider, type PendingLogin, type ProviderId } from './window/model'

const STATUS_BAR_ID = 'status-bar:quirky.accounts/usage'
const SETTINGS_ID = 'view:quirky.accounts/settings'
const ACCESSORY_ID = 'view:quirky.accounts/session-accessory'
const SWITCH_DIALOG_ID = 'overlay:quirky.accounts/switch-dialog'
const OPEN_COMMAND_ID = 'command:quirky.accounts/open'

let activeStore: AccountsUiStore | null = null


type CommandRefusal = { ok: false; reason: 'invalid-args' | 'owner-unavailable' | 'remote-owner' | 'login-changed' | 'clipboard-failed' }
type SelectAccountArgs = { provider: ManagedProvider; accountId: string | null; connId?: number }
type RefreshArgs = { provider?: ProviderId; connId?: number }
type CopyLoginLinkArgs = Pick<PendingLogin, 'id' | 'provider' | 'url'> & { connId?: number }
type RoutedCommandId = typeof SELECT_ACCOUNT_COMMAND_ID | typeof REFRESH_COMMAND_ID | typeof COPY_LOGIN_LINK_COMMAND_ID
type OriginRoute =
  | { kind: 'local' }
  | { kind: 'routed'; result: unknown }
  | { kind: 'refused'; refusal: CommandRefusal }

function isManagedProvider(value: unknown): value is ManagedProvider {
  return value === 'claude' || value === 'codex'
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDERS.some((provider) => provider === value)
}

function parseConnId(value: object): number | null | undefined {
  if (!Object.hasOwn(value, 'connId')) return undefined
  if (!('connId' in value)) return null
  const connId = value.connId
  return typeof connId === 'number' && Number.isSafeInteger(connId) && connId > 0 ? connId : null
}

function parseSelectAccountArgs(value: unknown): SelectAccountArgs | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      !Object.hasOwn(value, 'provider') || !('provider' in value) || !isManagedProvider(value.provider) ||
      !Object.hasOwn(value, 'accountId') || !('accountId' in value) ||
      !(value.accountId === null || typeof value.accountId === 'string')) return null
  const connId = parseConnId(value)
  if (connId === null) return null
  return { provider: value.provider, accountId: value.accountId, ...(connId === undefined ? {} : { connId }) }
}

function parseRefreshArgs(value: unknown): RefreshArgs | null {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const connId = parseConnId(value)
  if (connId === null) return null
  let provider: ProviderId | undefined
  if (Object.hasOwn(value, 'provider')) {
    if (!('provider' in value) || !isProviderId(value.provider)) return null
    provider = value.provider
  }
  return { ...(provider === undefined ? {} : { provider }), ...(connId === undefined ? {} : { connId }) }
}

function parseCopyLoginLinkArgs(value: unknown): CopyLoginLinkArgs | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      !Object.hasOwn(value, 'id') || !('id' in value) || typeof value.id !== 'string' || !value.id ||
      !Object.hasOwn(value, 'provider') || !('provider' in value) || !isManagedProvider(value.provider) ||
      !Object.hasOwn(value, 'url') || !('url' in value) || typeof value.url !== 'string' || !value.url) return null
  const connId = parseConnId(value)
  if (connId === null) return null
  return {
    id: value.id,
    provider: value.provider,
    url: value.url,
    ...(connId === undefined ? {} : { connId })
  }
}

function isRefusalReason(value: unknown): value is CommandRefusal['reason'] {
  return value === 'invalid-args' || value === 'owner-unavailable' || value === 'remote-owner' ||
    value === 'login-changed' || value === 'clipboard-failed'
}

function isCommandRefusal(value: unknown): value is CommandRefusal {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    'ok' in value && value.ok === false && 'reason' in value && isRefusalReason(value.reason)
}
function isCopySuccess(value: unknown): value is { ok: true } {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'ok' in value && value.ok === true
}


function routeResult(value: unknown): void | CommandRefusal {
  if (value === undefined || isCommandRefusal(value)) return value
  return { ok: false, reason: 'owner-unavailable' }
}

async function routeCommandToOrigin(
  context: UiPluginContext,
  connId: number | undefined,
  id: RoutedCommandId,
  args: Record<string, unknown>
): Promise<OriginRoute> {
  if (connId === undefined) return { kind: 'local' }
  let identity: unknown
  try {
    identity = await context.call('ui.window.self', {})
  } catch {
    return { kind: 'refused', refusal: { ok: false, reason: 'owner-unavailable' } }
  }
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity) ||
      !('connId' in identity) || typeof identity.connId !== 'number' ||
      !Number.isSafeInteger(identity.connId) || identity.connId < 1) {
    return { kind: 'refused', refusal: { ok: false, reason: 'owner-unavailable' } }
  }
  if (identity.connId === connId) return { kind: 'local' }
  try {
    const response = await context.call('ui.window.command.run', { connId, id, args })
    if (response === null || typeof response !== 'object' || Array.isArray(response) ||
        !('result' in response) || !Object.hasOwn(response, 'result')) {
      return { kind: 'refused', refusal: { ok: false, reason: 'owner-unavailable' } }
    }
    return { kind: 'routed', result: response.result }
  } catch {
    return { kind: 'refused', refusal: { ok: false, reason: 'owner-unavailable' } }
  }
}
function setRootClass(element: HTMLElement, kind: 'bar' | 'view' | 'overlay' | 'accessory'): void {
  element.classList.add('accounts-mount-root', `accounts-mount-root--${kind}`)
}

function mountStatusBar(store: AccountsUiStore): MountFunction {
  return (element, props) => {
    setRootClass(element, 'bar')
    const root = createRoot(element)
    root.render(<StatusBarUsage store={store} report={props.report} />)
    return () => root.unmount()
  }
}

export function activate(context: UiPluginContext): void {
  activeStore?.stop()
  const store = new AccountsUiStore(context)
  activeStore = store
  store.start()
  async function selectAccountCommand(args?: unknown): Promise<void | CommandRefusal> {
    const parsed = parseSelectAccountArgs(args)
    if (!parsed) return { ok: false, reason: 'invalid-args' }
    if (activeStore !== store) return { ok: false, reason: 'owner-unavailable' }
    const route = await routeCommandToOrigin(context, parsed.connId, SELECT_ACCOUNT_COMMAND_ID, {
      provider: parsed.provider,
      accountId: parsed.accountId
    })
    if (route.kind === 'refused') return route.refusal
    if (route.kind === 'routed') return routeResult(route.result)
    const scope = store.getSnapshot().scope
    if (scope.kind === 'remote' && scope.status !== 'ready') return { ok: false, reason: 'owner-unavailable' }
    await store.selectAccount(parsed.provider, parsed.accountId)
  }

  async function refreshCommand(args?: unknown): Promise<void | CommandRefusal> {
    const parsed = parseRefreshArgs(args)
    if (!parsed) return { ok: false, reason: 'invalid-args' }
    if (activeStore !== store) return { ok: false, reason: 'owner-unavailable' }
    const route = await routeCommandToOrigin(context, parsed.connId, REFRESH_COMMAND_ID, {
      ...(parsed.provider === undefined ? {} : { provider: parsed.provider })
    })
    if (route.kind === 'refused') return route.refusal
    if (route.kind === 'routed') return routeResult(route.result)
    await store.refresh(parsed.provider)
  }

  async function copyLoginLinkCommand(args?: unknown): Promise<{ ok: true } | CommandRefusal> {
    const parsed = parseCopyLoginLinkArgs(args)
    if (!parsed) return { ok: false, reason: 'invalid-args' }
    if (activeStore !== store) return { ok: false, reason: 'login-changed' }
    const route = await routeCommandToOrigin(context, parsed.connId, COPY_LOGIN_LINK_COMMAND_ID, {
      id: parsed.id,
      provider: parsed.provider,
      url: parsed.url
    })
    if (route.kind === 'refused') return route.refusal
    if (route.kind === 'routed') {
      if (isCommandRefusal(route.result)) return route.result
      return isCopySuccess(route.result) ? { ok: true } : { ok: false, reason: 'owner-unavailable' }
    }
    const snapshot = store.getSnapshot()
    if (snapshot.scope.kind === 'remote') return { ok: false, reason: 'remote-owner' }
    const pending = snapshot.login ?? snapshot.accounts?.pendingLogin
    if (!pending || pending.id !== parsed.id || pending.provider !== parsed.provider || pending.url !== parsed.url) {
      return { ok: false, reason: 'login-changed' }
    }
    function currentLoginMatches(): boolean {
      if (activeStore !== store) return false
      const currentSnapshot = store.getSnapshot()
      if (currentSnapshot.scope.kind === 'remote') return false
      const current = currentSnapshot.login ?? currentSnapshot.accounts?.pendingLogin
      return current?.id === parsed.id && current.provider === parsed.provider && current.url === parsed.url
    }
    try {
      await navigator.clipboard.writeText(parsed.url)
    } catch {
      if (currentLoginMatches()) context.toast('Could not copy the link', 'Use the Open link to continue sign-in in your browser.')
      return { ok: false, reason: 'clipboard-failed' }
    }
    if (currentLoginMatches()) {
      store.notify('Sign-in link copied', parsed.provider === 'codex'
        ? 'Open it in a private window or another browser profile.'
        : 'Open it in a private window to sign in with a different account.')
    }
    return { ok: true }
  }

  context.provide(SELECT_ACCOUNT_COMMAND_ID, selectAccountCommand)
  context.provide(COPY_LOGIN_LINK_COMMAND_ID, copyLoginLinkCommand)

  context.provide(STATUS_BAR_ID, mountStatusBar(store))
  const mountSettings: MountFunction = (element, props) => {
    setRootClass(element, 'view')
    const root = createRoot(element)
    root.render(<AccountsSettings context={context} store={store} report={props.report} />)
    return () => root.unmount()
  }
  context.provide(SETTINGS_ID, mountSettings)

  const mountAccessory: MountFunction = (element, props) => {
    setRootClass(element, 'accessory')
    const root = createRoot(element)
    root.render(<SessionAccessory store={store} input={props.input} report={props.report} />)
    return () => root.unmount()
  }
  context.provide(ACCESSORY_ID, mountAccessory)

  const mountSwitchDialog: MountFunction = (element, props) => {
    setRootClass(element, 'overlay')
    const root = createRoot(element)
    root.render(<AccountSwitchDialog store={store} report={props.report} />)
    return () => root.unmount()
  }
  context.provide(SWITCH_DIALOG_ID, mountSwitchDialog)
  context.provide(OPEN_COMMAND_ID, async () => {
    await store.setUiState({ open: true })
    if (!store.getSnapshot().accounts?.preferences.hidden) return
    await store.openSettingsSection('appearance')
  })
  context.provide(REFRESH_COMMAND_ID, refreshCommand)
}

export function deactivate(): void {
  activeStore?.stop()
  activeStore = null
}
