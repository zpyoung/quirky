// the dock composer's editor is CodeMirror: its content element is editable only while enabled
const DOCK_COMPOSER_INPUT_SELECTOR =
  '[data-terminal-dock]:not([data-terminal-dock-passthrough]) .cm-content[contenteditable="true"]'

type DockFocusablePane = {
  container: Pick<HTMLElement, 'querySelector'>
  terminal: { focus(): void }
}

function queryDockComposerInput(
  root: Pick<ParentNode, 'querySelector'> | null | undefined
): HTMLElement | null {
  if (typeof root?.querySelector !== 'function') {
    return null
  }
  return root.querySelector<HTMLElement>(DOCK_COMPOSER_INPUT_SELECTOR)
}

/** Finds the enabled dock composer that belongs to the pane containing an xterm surface. */
export function findDockComposerInput(surface: Element | null | undefined): HTMLElement | null {
  if (!surface || typeof surface.closest !== 'function') {
    return null
  }
  const pane = surface.closest<HTMLElement>('.pane[data-leaf-id]')
  return queryDockComposerInput(pane)
}

/** The pane's enabled dock composer, if it has one. */
export function findPaneDockComposer(
  pane: Pick<DockFocusablePane, 'container'> | null | undefined
): HTMLElement | null {
  return pane ? queryDockComposerInput(pane.container) : null
}

/** Focuses a pane's dock composer when available, otherwise its terminal. */
export function focusPaneOrDockComposer(pane: DockFocusablePane | null | undefined): void {
  if (!pane) {
    return
  }
  const composer = queryDockComposerInput(pane.container)
  if (composer) {
    composer.focus()
    return
  }
  pane.terminal.focus()
}
