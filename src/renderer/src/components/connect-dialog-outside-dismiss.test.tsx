// @vitest-environment happy-dom

import { act } from 'react'
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JiraConnectDialog } from './jira-connect-dialog'
import { LinearApiKeyDialog } from './linear-api-key-dialog'

type StoreState = {
  settings: { activeRuntimeEnvironmentId: string | null }
  connectJira: (input: unknown) => Promise<{ ok: boolean; error?: string }>
  connectLinear: (apiKey: string) => Promise<{ ok: boolean; error?: string }>
}

const mocks = vi.hoisted(() => {
  const store: { current: StoreState | null } = { current: null }
  return { store }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => {
    if (!mocks.store.current) {
      throw new Error('Store state was not installed')
    }
    return selector(mocks.store.current)
  }
}))

let root: Root | null = null

beforeEach(() => {
  mocks.store.current = {
    settings: { activeRuntimeEnvironmentId: null },
    connectJira: vi.fn(async () => ({ ok: true })),
    connectLinear: vi.fn(async () => ({ ok: true }))
  }
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  document.body.innerHTML = ''
  mocks.store.current = null
})

async function renderDialog(ui: ReactElement, existingRoot?: Root): Promise<Root> {
  const targetRoot = existingRoot ?? createRoot(appendContainer())
  root = targetRoot
  await act(async () => {
    targetRoot.render(ui)
  })
  // Why: Radix attaches its document pointerdown listener on a setTimeout(0), so a
  // synchronous dispatch right after mount is missed.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return targetRoot
}

function appendContainer(): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  return container
}

async function outsideClick(): Promise<void> {
  await act(async () => {
    // Why: modal DialogContent sets deferPointerDownOutside, so the dismissal resolves on the
    // click that follows the outside pointerdown. Events must bubble to reach the document listeners.
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
  if (!input) {
    throw new Error(`missing input with placeholder ${placeholder}`)
  }
  return input
}

function buttonByText(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

describe('JiraConnectDialog outside dismiss', () => {
  it('keeps a typed site URL when the backdrop is clicked', async () => {
    const onOpenChange = vi.fn()
    await renderDialog(<JiraConnectDialog open onOpenChange={onOpenChange} />)
    const siteUrl = inputByPlaceholder('https://example.atlassian.net')

    await type(siteUrl, 'https://acme.atlassian.net')
    await outsideClick()

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(siteUrl.value).toBe('https://acme.atlassian.net')
  })

  it('keeps a typed email and API token when the backdrop is clicked', async () => {
    const onOpenChange = vi.fn()
    await renderDialog(<JiraConnectDialog open onOpenChange={onOpenChange} />)

    await type(inputByPlaceholder('you@example.com'), 'dev@example.com')
    await outsideClick()
    expect(onOpenChange).not.toHaveBeenCalled()

    await type(inputByPlaceholder('Atlassian API token'), 'jira-token')
    await outsideClick()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('still dismisses on a backdrop click while the form is clean', async () => {
    const onOpenChange = vi.fn()
    await renderDialog(<JiraConnectDialog open onOpenChange={onOpenChange} />)

    await outsideClick()

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // Why: mode switches clear the credential fields, so a toggle alone leaves nothing to lose.
  it('still dismisses on a backdrop click after a mode toggle with nothing typed', async () => {
    const onOpenChange = vi.fn()
    await renderDialog(<JiraConnectDialog open onOpenChange={onOpenChange} />)

    await click(buttonByText('Self-hosted'))
    expect(inputByPlaceholder('https://jira.example.com')).not.toBeNull()
    await outsideClick()

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('still discards a typed draft on Escape', async () => {
    const onOpenChange = vi.fn()
    await renderDialog(<JiraConnectDialog open onOpenChange={onOpenChange} />)

    await type(inputByPlaceholder('https://example.atlassian.net'), 'https://acme.atlassian.net')
    await pressEscape()

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('LinearApiKeyDialog outside dismiss', () => {
  it('keeps a typed key when the backdrop is clicked', async () => {
    const onOpenChange = vi.fn()
    await renderDialog(<LinearApiKeyDialog open onOpenChange={onOpenChange} />)
    const key = inputByPlaceholder('lin_api_...')

    await type(key, 'lin_api_secret')
    await outsideClick()

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(key.value).toBe('lin_api_secret')
  })

  it('still dismisses on a backdrop click while the key is empty', async () => {
    const onOpenChange = vi.fn()
    await renderDialog(<LinearApiKeyDialog open onOpenChange={onOpenChange} />)

    await outsideClick()

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('still discards a typed key on Escape', async () => {
    const onOpenChange = vi.fn()
    await renderDialog(<LinearApiKeyDialog open onOpenChange={onOpenChange} />)

    await type(inputByPlaceholder('lin_api_...'), 'lin_api_secret')
    await pressEscape()

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
