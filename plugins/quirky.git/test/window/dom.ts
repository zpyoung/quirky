/** DOM helpers for driving the Source Control panel and diff view in a headless window. */

export const q = (selector: string, root: ParentNode = document): HTMLElement | null => root.querySelector<HTMLElement>(selector)
export const qa = (selector: string, root: ParentNode = document): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)]

const settle = () => Bun.sleep(30)

export const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

export const buttonText = (label: string, root: ParentNode = document): HTMLButtonElement | undefined =>
  qa('button', root).find((b) => text(b) === label) as HTMLButtonElement | undefined

export const byLabel = (label: string, root: ParentNode = document): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)

export const dialogNamed = (title: string): HTMLElement | undefined =>
  qa('[role="dialog"]').find((dialog) => {
    const titleId = dialog.getAttribute('aria-labelledby')
    return titleId !== null && document.getElementById(titleId)?.textContent === title
  })

/**
 * The Changes list row (`role="option"`) for `path`. The list has no sections, so `section` only
 * narrows by state: `staged` wants the filled uncommitted dot and `branch` a row with no dot.
 */
export const rowOf = (path: string, section?: string): HTMLElement | null => {
  const row = qa('[role="option"][data-row-path]').find((candidate) => candidate.getAttribute('data-row-path') === path) ?? null
  if (row === null) return null
  const staged = q('.git-row__dirty--staged', row) !== null
  const dirty = q('.git-row__dirty', row) !== null
  if (section === 'staged') return staged ? row : null
  if (section === 'branch') return dirty ? null : row
  return row
}

export const rowContainerOf = (path: string, section?: string): HTMLElement | null => rowOf(path, section)

export const rowPaths = (): string[] => qa('[role="option"][data-row-path]').map((row) => row.getAttribute('data-row-path') ?? '')
export const selectedPaths = (): string[] =>
  qa('[role="option"][aria-selected="true"]').map((row) => row.getAttribute('data-row-path') ?? '')
export const listbox = (): HTMLElement | null => q('[role="listbox"]')

export const sectionHeadings = (): string[] => qa('[data-section] h2').map((el) => text(el))

export async function click(element: Element | null | undefined, init: MouseEventInit = {}): Promise<void> {
  if (!element) throw new Error('nothing to click')
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  await settle()
}

export async function press(target: Element | Window | Document, key: string, init: KeyboardEventInit = {}): Promise<void> {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  await settle()
}

export async function type(control: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(control, value)
  control.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

/** The ship button; null while the bar shows the quiet status line, the conflict card or nothing. */
export const primary = (): HTMLButtonElement => q('.ui-split-button__primary') as HTMLButtonElement
export const messageBox = (): HTMLTextAreaElement => q('textarea[aria-label="Commit message"]') as HTMLTextAreaElement

/** What the ship bar shows now: the button's label, enabled and title, or the quiet line's text. */
export const primaryNow = () => {
  const button = q('.ui-split-button__primary') as HTMLButtonElement | null
  if (button) return { label: text(button), enabled: !button.disabled, title: button.title }
  const quiet = q('[data-git-up-to-date]')
  return { label: text(quiet), enabled: false, title: quiet?.title ?? '' }
}

/** The ship bar's error line, or null when none shows. */
export const errorLine = (): HTMLElement | null => q('.ui-inline-error')

/** The caret entry with this label, once its menu is open. */
export const caretEntry = (label: string): HTMLButtonElement | undefined =>
  qa('[role="menuitem"]').find((item) => text(q('.qt-menu-label', item)?.firstChild as Element | null) === label) as HTMLButtonElement | undefined

export async function modEnter(element: Element): Promise<void> {
  await press(element, 'Enter', { metaKey: true })
}

export const toasts = (): string[] =>
  qa('[aria-live="polite"] [role="status"], [aria-live="polite"] [role="alert"]').map(text)

/**
 * Presses the save chord on a CodeMirror editor's content. CodeMirror decides at load time whether
 * Mod is Cmd or Ctrl, so the chord that gets its default prevented is the one it took.
 */
export async function modS(editor: { contentDOM: HTMLElement }): Promise<void> {
  for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
    const unhandled = editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', keyCode: 83, ...mod, bubbles: true, cancelable: true }))
    if (!unhandled) break
  }
  await Bun.sleep(80)
}

/**
 * Replaces IntersectionObserver with one whose callbacks the test fires, since a headless
 * window never scrolls. `restore` puts the original back.
 */
export function stubIntersectionObserver() {
  type Entry = { callback: IntersectionObserverCallback; element: Element; observer: object }
  const entries: Entry[] = []
  const original = globalThis.IntersectionObserver
  class Stub {
    constructor(readonly callback: IntersectionObserverCallback) {}
    observe(element: Element) {
      entries.push({ callback: this.callback, element, observer: this })
    }
    disconnect() {
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.observer === this) entries.splice(i, 1)
    }
    unobserve() {}
    takeRecords() {
      return []
    }
  }
  globalThis.IntersectionObserver = Stub as unknown as typeof IntersectionObserver
  return {
    /** Reports every observed element as in view. */
    async revealAll() {
      for (const entry of [...entries]) {
        entry.callback([{ isIntersecting: true, target: entry.element } as IntersectionObserverEntry], entry.observer as IntersectionObserver)
      }
      await Bun.sleep(30)
    },
    restore() {
      globalThis.IntersectionObserver = original
    }
  }
}

/** The modified-side CodeMirror editor in the active hosted Git diff. */
export function modifiedEditor<T>(EditorView: { findFromDOM(dom: HTMLElement): T | null }, root?: ParentNode): T {
  const scope = root ?? q('[data-git-view-root]')
  if (!scope) throw new Error('Git diff view is not mounted')
  const editors = qa('[contenteditable]', scope)
  const editor = editors[editors.length - 1]
  if (!editor) throw new Error('Git diff view has no editor')
  const view = EditorView.findFromDOM(editor)
  if (!view) throw new Error('Git diff view editor is not mounted')
  return view
}
