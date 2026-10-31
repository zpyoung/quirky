type EditorFocus = () => void
type Handoff = { tabId: string | null; requested: boolean }

export type EditorFocusHandoff = {
  setTarget(tabId: string): void
  request(): void
  cancel(): void
}

const editors = new Map<string, EditorFocus>()
let activeHandoff: Handoff | null = null

function clearHandoff(handoff: Handoff): void {
  if (activeHandoff !== handoff) return
  activeHandoff = null
  document.removeEventListener('pointerdown', cancelOnPointerDown, true)
  document.removeEventListener('keydown', cancelOnNavigation, true)
}

function cancelActiveHandoff(): void {
  if (activeHandoff) clearHandoff(activeHandoff)
}

function cancelOnPointerDown(): void {
  cancelActiveHandoff()
}

function cancelOnNavigation(event: KeyboardEvent): void {
  if (
    event.key === 'Tab' || event.key === 'Escape' ||
    event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End' ||
    event.key === 'PageUp' || event.key === 'PageDown' || event.metaKey || event.ctrlKey
  ) cancelActiveHandoff()
}

function focusHandoffIfReady(handoff: Handoff): void {
  if (activeHandoff !== handoff || !handoff.requested || handoff.tabId === null) return
  const focus = editors.get(handoff.tabId)
  if (!focus) return
  clearHandoff(handoff)
  focus()
}

export function beginEditorFocusHandoff(): EditorFocusHandoff {
  cancelActiveHandoff()
  const handoff: Handoff = { tabId: null, requested: false }
  activeHandoff = handoff
  document.addEventListener('pointerdown', cancelOnPointerDown, true)
  document.addEventListener('keydown', cancelOnNavigation, true)
  return {
    setTarget(tabId) {
      if (activeHandoff !== handoff || tabId === '') return
      handoff.tabId = tabId
      focusHandoffIfReady(handoff)
    },
    request() {
      if (activeHandoff !== handoff) return
      handoff.requested = true
      focusHandoffIfReady(handoff)
    },
    cancel() {
      clearHandoff(handoff)
    }
  }
}

export function cancelEditorFocus(tabId: string): void {
  if (activeHandoff?.tabId === tabId) cancelActiveHandoff()
}

export function registerEditorFocus(tabId: string, focus: EditorFocus): () => void {
  if (tabId === '') return () => {}
  editors.set(tabId, focus)
  if (activeHandoff?.tabId === tabId) focusHandoffIfReady(activeHandoff)
  return () => {
    if (editors.get(tabId) === focus) editors.delete(tabId)
  }
}
