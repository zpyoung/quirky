import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag,
  getRequiredStringFlagAllowingEmpty
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import { SettingsUpdate } from '../../shared/rpc-contract/client-settings-params'
import { publicCallOptions } from './ui-actions'

type SettingsResult = { settings: Record<string, unknown> }

type NotificationEntry = {
  type?: string
  notificationSeq?: number
  notificationId?: string
  title?: string
  body?: string
}

type NotificationListResult = { notifications: NotificationEntry[]; epoch: string }

const SETTING_KEYS: readonly string[] = Object.keys(SettingsUpdate.def.innerType.shape)

function parseSettingValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function formatSettingValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function formatSettingLines(result: SettingsResult): string {
  return Object.entries(result.settings)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${formatSettingValue(value)}`)
    .join('\n')
}

function formatNotificationList(result: NotificationListResult): string {
  if (result.notifications.length === 0) {
    return 'No notifications.'
  }
  return result.notifications
    .map((entry) => {
      const label = entry.type === 'dismiss' ? 'dismissed' : (entry.title ?? '')
      const detail = entry.body ? ` - ${entry.body}` : ''
      return `${entry.notificationSeq ?? '-'}  ${entry.notificationId ?? '-'}  ${label}${detail}`
    })
    .join('\n')
}

function requireKnownSetting(key: string): void {
  if (!SETTING_KEYS.includes(key)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown setting "${key}". Valid keys: ${SETTING_KEYS.join(', ')}`
    )
  }
}

async function setSetting(ctx: HandlerContext): Promise<void> {
  const { flags, client, json } = ctx
  const key = getRequiredStringFlag(flags, 'key')
  const value = parseSettingValue(getRequiredStringFlagAllowingEmpty(flags, 'value'))
  requireKnownSetting(key)
  const response = await client.call<SettingsResult>(
    'settings.update',
    { [key]: value },
    publicCallOptions(flags.has('yes'))
  )
  printResult(
    response,
    json,
    (result) => `${key}: ${formatSettingValue(result.settings[key] ?? value)}`
  )
}

async function getSettings(ctx: HandlerContext): Promise<void> {
  const { flags, client, json } = ctx
  const key = getOptionalStringFlag(flags, 'key')
  const response = await client.call<SettingsResult>('settings.get', undefined, publicCallOptions())
  if (key === undefined) {
    printResult(response, json, (result) => JSON.stringify(result, null, 2))
    return
  }
  if (!Object.hasOwn(response.result.settings, key)) {
    throw new RuntimeClientError('not_found', `No setting named "${key}".`, {
      next: [{ command: 'quirky settings list', why: 'list every setting' }]
    })
  }
  const value = response.result.settings[key]
  printResult({ ...response, result: { settings: { [key]: value } } }, json, () =>
    formatSettingValue(value)
  )
}

function setPluginEnabled(enabled: boolean): CommandHandler {
  return async ({ flags, client, json }) => {
    const pluginKey = getRequiredStringFlag(flags, 'key')
    const response = await client.call<unknown>(
      'plugins.setEnabled',
      { pluginKey, enabled },
      publicCallOptions()
    )
    printResult(response, json, () => `${enabled ? 'Enabled' : 'Disabled'} plugin ${pluginKey}`)
  }
}

export const ADMIN_HANDLERS: Record<string, CommandHandler> = {
  'settings get': getSettings,
  'settings set': setSetting,
  'settings list': async ({ client, json }) => {
    const response = await client.call<SettingsResult>(
      'settings.get',
      undefined,
      publicCallOptions()
    )
    printResult(response, json, formatSettingLines)
  },
  'plugins enable': setPluginEnabled(true),
  'plugins disable': setPluginEnabled(false),
  'notifications list': async ({ flags, client, json }) => {
    const lastSeenSeq = getOptionalNonNegativeIntegerFlag(flags, 'last-seen-seq') ?? 0
    const response = await client.call<NotificationListResult>(
      'notifications.getMissedSince',
      { lastSeenSeq },
      publicCallOptions()
    )
    printResult(response, json, formatNotificationList)
  },
  'notifications dismiss': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const response = await client.call<{ dismissed: true; id: string }>(
      'notifications.dismiss',
      { id },
      publicCallOptions()
    )
    printResult(response, json, () => `Dismissed notification ${id}`)
  }
}
