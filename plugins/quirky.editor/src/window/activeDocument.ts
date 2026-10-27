export type ActiveDocument = {
  bufferId: string
  tabId: string | null
  worktreeId: string
  path: string
  flush(): Promise<void>
  save(): Promise<void>
  focus(): void
  close(): Promise<boolean>
}

let active: ActiveDocument | null = null

export function registerActiveDocument(document: ActiveDocument): () => void {
  const previous = active
  active = document
  return () => {
    if (active === document) active = previous
  }
}

export function activeDocument(): ActiveDocument | null {
  return active
}
