import { parseContributionId } from '@quirky/protocol'

type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>
export type ViewMenuSetting = { id: string; label: string; checked: boolean }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Native menus are projections of the same effective declarations and values as the CLI. */
export async function loadViewMenuSettings(call: Call): Promise<ViewMenuSetting[]> {
  const entries = await call('setting.list', {})
  if (!Array.isArray(entries)) throw new Error('Settings list is unavailable')
  const items: ViewMenuSetting[] = []
  for (const entry of entries) {
    if (!record(entry) || entry.menu !== 'view') continue
    if (entry.type !== 'boolean' || typeof entry.value !== 'boolean' || typeof entry.id !== 'string' || typeof entry.title !== 'string') throw new Error('Invalid native View menu setting')
    items.push({ id: entry.id, label: entry.title, checked: entry.value })
  }
  return items.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
}

/** Read at activation time: a stale native checkmark must not overwrite a newer scripted toggle. */
export async function toggleViewMenuSetting(call: Call, id: string): Promise<void> {
  if (parseContributionId(id)?.kind !== 'setting') throw new Error('Invalid View menu setting ID')
  const current = await call('setting.get', { id })
  if (!record(current) || current.type !== 'boolean' || current.menu !== 'view' || typeof current.value !== 'boolean') throw new Error('This setting is no longer available in the View menu')
  await call('setting.set', { id, value: !current.value })
}

export function viewMenuSettingFromEvent(event: unknown): string | null {
  if (!record(event) || !record(event.data) || typeof event.data.action !== 'string' || !event.data.action.startsWith('view-setting:')) return null
  try {
    const id = decodeURIComponent(event.data.action.slice('view-setting:'.length))
    return parseContributionId(id)?.kind === 'setting' ? id : null
  } catch { return null }
}
