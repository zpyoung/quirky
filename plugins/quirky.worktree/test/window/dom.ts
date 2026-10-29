/** DOM helpers for driving the worktree plugin's dialogs in a headless window. */

export const dialogs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]

/** The dialog on top, or undefined with none open. */
export const topDialog = (): HTMLElement | undefined => dialogs().at(-1)

export const dialogNamed = (title: string): HTMLElement | undefined => dialogs().find((dialog) => accessibleName(dialog) === title)

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

const normalizeText = (value: string | null | undefined): string => value?.replace(/\s+/g, ' ').trim() ?? ''
const visibleText = (node: Node): string => {
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return ''
  return [...node.childNodes].map(visibleText).join('')
}

export function accessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean)
  if (labelledBy?.length) {
    return normalizeText(labelledBy.map((id) => {
      const target = element.ownerDocument.getElementById(id)
      return target ? visibleText(target) : ''
    }).join(' '))
  }

  const ariaLabel = element.getAttribute('aria-label')
  if (ariaLabel !== null) return normalizeText(ariaLabel)

  const labels = (element as Control).labels
  if (labels) {
    const name = normalizeText([...labels].map((label) => label.textContent).join(' '))
    if (name) return name
  }

  return normalizeText(visibleText(element))
}

export const sectionHeading = (section: ParentNode): string | undefined => {
  const heading = section.querySelector<HTMLElement>(':scope > header h2')
  return heading ? accessibleName(heading) : undefined
}
export function sectionHeadingMatches(section: ParentNode, name: string): boolean {
  const heading = sectionHeading(section)
  return heading === name || heading?.endsWith(` ${name}`) === true
}

export const menuItem = (root: ParentNode, label: string): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    accessibleName(item) === label
  )

/** Finds an input, select or textarea by its native label or ARIA name. */
export function field<T extends Control = HTMLInputElement>(root: ParentNode, label: string): T | undefined {
  const name = normalizeText(label)
  return [...root.querySelectorAll<Control>('input, select, textarea')].find((control) => {
    const nativeName = control.labels && normalizeText([...control.labels].map((candidate) => candidate.textContent).join(' '))
    return accessibleName(control) === name || nativeName === name
  }) as T | undefined
}

export const button = (root: ParentNode, name: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => accessibleName(candidate) === name)

const settle = () => Bun.sleep(25)

export async function setText(control: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(control, value)
  control.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

export async function setSelect(control: HTMLSelectElement, value: string): Promise<void> {
  control.value = value
  control.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
}

export async function click(element: HTMLElement): Promise<void> {
  element.click()
  await settle()
}
export async function openDisclosure(name: string): Promise<void> {
  const summary = [...document.querySelectorAll<HTMLElement>('details > summary')].find((item) => accessibleName(item) === name)
  if (!summary) throw new Error(`no disclosure named ${name}`)
  const disclosure = summary.parentElement as HTMLDetailsElement
  if (!disclosure.open) summary.click()
  await settle()
}

/** Presses Mod+Enter (Cmd, as the headless window reports a Mac) on `element`. */
export async function modEnter(element: HTMLElement): Promise<void> {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
  await settle()
}

export async function pressEscape(): Promise<void> {
  const active = document.activeElement
  if (active instanceof HTMLElement && active.closest('[role="menu"], [role="dialog"]')) {
    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  } else {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  }
  await settle()
}


const liveToastSelector = '[aria-live][role="status"], [aria-live][role="alert"]'
export const toastMessages = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(liveToastSelector)].map((toast) => normalizeText(visibleText(toast)))

export const toastContaining = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(liveToastSelector)].find((toast) =>
    normalizeText(visibleText(toast)).includes(text)
  )
