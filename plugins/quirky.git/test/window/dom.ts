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
  qa('[role="dialog"]').find((d) => d.getAttribute('aria-label') === title)

/** The panel's row button for `path` (the main button of the row), optionally within a section. */
export const rowOf = (path: string, section?: string): HTMLElement | null =>
  q(`${section ? `[data-section="${section}"] ` : ''}.scm-row-main[title="${path}"]`)

export const sectionHeadings = (): string[] => qa('.scm-section-title').map((el) => text(el))

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

export const primary = (): HTMLButtonElement => q('.scm-primary') as HTMLButtonElement
export const messageBox = (): HTMLTextAreaElement => q('textarea[aria-label="Commit message"]') as HTMLTextAreaElement

/** What the primary button shows now: label, enabled and title. */
export const primaryNow = () => ({ label: text(primary()), enabled: !primary().disabled, title: primary().title })

export async function modEnter(element: Element): Promise<void> {
  await press(element, 'Enter', { metaKey: true })
}

export const toasts = (): Array<{ title: string; body: string }> =>
  qa('.toast').map((t) => ({ title: text(q('.toast-title', t)), body: text(q('.toast-body', t)) }))

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

/** The last CodeMirror editor under `root`: the modified side of a diff. */
export function modifiedEditor(EditorView: { findFromDOM(dom: HTMLElement): any }, root: ParentNode = document): any {
  const editors = qa('.cm-editor', root)
  return EditorView.findFromDOM(editors[editors.length - 1]!)
}
