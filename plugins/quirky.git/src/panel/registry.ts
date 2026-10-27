/** What window commands can do to the mounted Source Control panel. */
export type PanelHandle = {
  setFilter(query: string): void
  select(paths: string[]): void
  toggleHistory(open?: boolean): void
  refreshCompare(): void
}

let current: PanelHandle | null = null

/** Makes `handle` the panel commands act on until the returned function runs. */
export function registerPanel(handle: PanelHandle): () => void {
  current = handle
  return () => {
    if (current === handle) current = null
  }
}

/** The mounted panel; throws when none is open, so a command reports it rather than doing nothing. */
export function activePanel(): PanelHandle {
  if (current === null) throw new Error('Source Control is not open.')
  return current
}
