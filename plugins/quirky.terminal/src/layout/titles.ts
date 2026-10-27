import type { Tab } from './types'

const DEFAULT_TITLE = /^Terminal (\d+)$/

/** The default title for a new terminal tab: "Terminal N" with the lowest N >= 1 no existing title uses. */
export function nextTerminalTitle(existingTitles: readonly string[]): string {
  const used = new Set<number>()
  for (const title of existingTitles) {
    const match = DEFAULT_TITLE.exec(title)
    if (match) used.add(Number(match[1]))
  }
  let n = 1
  while (used.has(n)) n += 1
  return `Terminal ${n}`
}

/** What a tab's label reads: its custom title, else the shell's live title, else its default. */
export function displayTitle(tab: Pick<Tab, 'customTitle' | 'liveTitle' | 'defaultTitle'>): string {
  if (tab.customTitle && tab.customTitle.trim()) return tab.customTitle
  if (tab.liveTitle && tab.liveTitle.trim()) return tab.liveTitle
  return tab.defaultTitle
}

/** `recent` with `id` moved (or added) at the front. */
export function touchRecent(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((entry) => entry !== id)]
}

/** `recent` without `id`. */
export function removeRecent(recent: readonly string[], id: string): string[] {
  return recent.filter((entry) => entry !== id)
}

/**
 * Tab IDs in the order Ctrl+Tab lists them: most recently used first, then tabs the list has not
 * seen in position order. IDs in `recent` that are not in `tabs` are dropped.
 */
export function recentOrder(tabs: readonly Pick<Tab, 'id'>[], recent: readonly string[]): string[] {
  const present = new Set(tabs.map((tab) => tab.id))
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const id of [...recent, ...tabs.map((tab) => tab.id)]) {
    if (present.has(id) && !seen.has(id)) {
      seen.add(id)
      ordered.push(id)
    }
  }
  return ordered
}
