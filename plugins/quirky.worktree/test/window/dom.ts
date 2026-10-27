/** DOM helpers for driving the worktree plugin's dialogs in a headless window. */

export const dialogs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]

/** The dialog on top, or undefined with none open. */
export const topDialog = (): HTMLElement | undefined => dialogs().at(-1)

export const dialogNamed = (title: string): HTMLElement | undefined => dialogs().find((d) => d.getAttribute('aria-label') === title)

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

/** The input, select or textarea inside the `<label>` whose first `<span>` reads `label`. */
export function field<T extends Control = HTMLInputElement>(root: ParentNode, label: string): T | undefined {
  const holder = [...root.querySelectorAll('label')].find((l) => l.querySelector(':scope > span')?.textContent === label)
  return (holder?.querySelector('input, select, textarea') ?? undefined) as T | undefined
}

export const button = (root: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)

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

/** Presses Mod+Enter (Cmd, as the headless window reports a Mac) on `element`. */
export async function modEnter(element: HTMLElement): Promise<void> {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
  await settle()
}

export async function pressEscape(): Promise<void> {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
}

export const toastTitles = (): string[] => [...document.querySelectorAll('.toast-title')].map((e) => e.textContent ?? '')
