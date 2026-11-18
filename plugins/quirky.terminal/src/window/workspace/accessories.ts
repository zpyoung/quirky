import { parseContributionId, type UiPluginContext } from '@quirky/protocol'

export type TerminalAccessory = { id: string; plugin: string; title: string; order: number; view: string }
export type TerminalAccessorySource = {
  getSnapshot(): readonly TerminalAccessory[]
  subscribe(listener: () => void): () => void
}

const EMPTY_ACCESSORIES: readonly TerminalAccessory[] = []
const sources = new WeakMap<UiPluginContext, TerminalAccessorySource>()

function terminalAccessoriesOf(contributions: unknown, model: unknown): TerminalAccessory[] {
  if (!Array.isArray(contributions) || typeof model !== 'object' || model === null || Array.isArray(model) || !('views' in model)) {
    return []
  }
  const rawViews: unknown = model.views
  if (!Array.isArray(rawViews)) return []
  const accessories: TerminalAccessory[] = []
  for (const raw of contributions as unknown[]) {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      Array.isArray(raw) ||
      !('id' in raw) ||
      !('kind' in raw) ||
      !('plugin' in raw) ||
      !('status' in raw) ||
      !('data' in raw)
    ) {
      continue
    }
    const id = raw.id
    if (typeof id !== 'string') continue
    const parsedId = parseContributionId(id)
    if (parsedId?.kind !== 'terminal-accessory' || raw.kind !== 'terminal-accessory' || raw.status !== 'effective') continue
    if (typeof raw.plugin !== 'string') continue
    const data = raw.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) continue
    if (Object.keys(data).some((key) => !['title', 'order', 'view'].includes(key))) continue
    const title = Reflect.get(data, 'title')
    const view = Reflect.get(data, 'view')
    const rawOrder = Reflect.get(data, 'order')
    if (typeof title !== 'string' || title.trim() === '' || typeof view !== 'string') continue
    const order = rawOrder === undefined ? 100 : rawOrder
    if (typeof order !== 'number' || !Number.isFinite(order) || parseContributionId(view)?.kind !== 'view') continue
    const available = rawViews.some(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        'id' in candidate &&
        candidate.id === view &&
        'module' in candidate &&
        typeof candidate.module === 'string' &&
        candidate.module !== ''
    )
    if (!available) continue
    accessories.push({ id, plugin: raw.plugin, title, order, view })
  }
  accessories.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return accessories
}

function sameAccessories(left: readonly TerminalAccessory[], right: readonly TerminalAccessory[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index]
    return (
      entry.id === other?.id &&
      entry.plugin === other.plugin &&
      entry.title === other.title &&
      entry.order === other.order &&
      entry.view === other.view
    )
  })
}

function createSource(context: UiPluginContext): TerminalAccessorySource {
  let snapshot = EMPTY_ACCESSORIES
  let started = false
  let generation = 0
  let refreshInFlight = false
  let refreshAgain = false
  const listeners = new Set<() => void>()

  const refresh = async (): Promise<void> => {
    if (refreshInFlight) {
      refreshAgain = true
      return
    }
    refreshInFlight = true
    const requestGeneration = generation
    try {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => context.call('plugin.contributions', { kind: 'terminal-accessory' })),
        Promise.resolve().then(() => context.call('ui.contributions', {}))
      ])
      if (requestGeneration !== generation) return
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') {
        context.log(`terminal accessory refresh failed: ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}`)
        return
      }
      const next = terminalAccessoriesOf(results[0]!.status === 'fulfilled' ? results[0]!.value : undefined, results[1]!.status === 'fulfilled' ? results[1]!.value : undefined)
      if (sameAccessories(snapshot, next)) return
      snapshot = next
      for (const listener of [...listeners]) listener()
    } finally {
      refreshInFlight = false
      if (refreshAgain) {
        refreshAgain = false
        void refresh()
      }
    }
  }

  const invalidate = () => {
    generation++
    if (refreshInFlight) {
      refreshAgain = true
      return
    }
    void refresh()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      if (!started) {
        started = true
        context.subscribe((event) => {
          if (event.type === 'plugin.changed') invalidate()
        })
        context.onConnection((status) => {
          if (status === 'connected') invalidate()
        })
        invalidate()
      }
      return () => listeners.delete(listener)
    }
  }
}

export function getTerminalAccessorySource(context: UiPluginContext): TerminalAccessorySource {
  let source = sources.get(context)
  if (!source) {
    source = createSource(context)
    sources.set(context, source)
  }
  return source
}
