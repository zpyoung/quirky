import type { EditorKind, EditorMode } from '../types'

export type ActiveDocumentCommand =
  | 'find'
  | 'replace'
  | 'copy-context'
  | 'add-review-note'
  | 'zoom-in'
  | 'zoom-out'
  | 'reset-zoom'
  | 'toggle-word-wrap'
  | 'markdown-preview'

export type ActiveDocument = {
  bufferId: string
  tabId: string | null
  worktreeId: string
  path: string
  mode: EditorMode
  kind: EditorKind
  flush(): Promise<void>
  save(): Promise<void>
  focus(): void
  close(): Promise<boolean>
  runCommand(command: ActiveDocumentCommand, args?: Record<string, unknown>): Promise<unknown>
}

export type ActiveDocumentRegistration = {
  focus(): void
  blur(): void
  update(document: ActiveDocument): void
  unregister(): void
}

const mounted = new Map<symbol, ActiveDocument>()
let focused: symbol | null = null

export function registerActiveDocument(document: ActiveDocument): ActiveDocumentRegistration {
  const id = Symbol('active-document')
  mounted.set(id, document)
  let registered = true
  return {
    focus() {
      if (registered && mounted.has(id)) focused = id
    },
    blur() {
      if (registered && focused === id) focused = null
    },
    update(next) {
      if (registered && mounted.has(id)) mounted.set(id, next)
    },
    unregister() {
      if (!registered) return
      registered = false
      mounted.delete(id)
      if (focused === id) focused = null
    }
  }
}

export function activeDocument(): ActiveDocument | null {
  return focused === null ? null : mounted.get(focused) ?? null
}
