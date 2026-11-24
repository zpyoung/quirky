// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { RepositoryLedgerSection } from './RepositoryLedgerSection'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state = { request: vi.fn(), searchQuery: '' }
  return {
    ...state,
    state,
    useAppStore: (
      selector: (value: { ledgerRequest: unknown; settingsSearchQuery: string }) => unknown
    ) => selector({ ledgerRequest: state.request, settingsSearchQuery: state.searchQuery })
  }
})
vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const repo = { id: 'repo-a', displayName: 'quirky' } as Repo
const summary = { ledgerId: 'ledger-1', revision: 4, staleAfterDays: 90 }

let container: HTMLDivElement
let root: Root

async function render(): Promise<void> {
  await act(async () => {
    root.render(<RepositoryLedgerSection repo={repo} forceVisible={true} />)
  })
}

function setInput(value: string): void {
  const input = container.querySelector('input')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function saveButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((node) => node.textContent === 'Save')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.searchQuery = ''
  mocks.request.mockResolvedValue({ ledger: summary })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('RepositoryLedgerSection', () => {
  it('reads the threshold from the project ledger without creating one', async () => {
    await render()
    expect(mocks.request).toHaveBeenCalledWith(
      { operation: 'list', target: { owner: { tier: 'project', id: 'repo:repo-a' } } },
      undefined
    )
    expect(container.querySelector('input')?.value).toBe('90')
    expect(saveButton()?.disabled).toBe(true)
  })
  it('saves against the ledger revision it read', async () => {
    await render()
    setInput('30')
    expect(saveButton()?.disabled).toBe(false)
    await act(async () => saveButton()!.click())
    expect(mocks.request).toHaveBeenLastCalledWith(
      {
        operation: 'settings',
        target: { ledgerId: 'ledger-1' },
        ifLedgerRevision: 4,
        staleAfterDays: 30
      },
      undefined
    )
  })
  it.each([['-1'], ['1.5'], ['']])('refuses to save %s', async (value) => {
    await render()
    setInput(value)
    expect(saveButton()?.disabled).toBe(true)
  })
  it('keeps the rejected save visible and the controls usable', async () => {
    await render()
    setInput('30')
    mocks.request.mockRejectedValueOnce(new Error('Ledger revision is stale'))
    await act(async () => saveButton()!.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Ledger revision is stale')
    expect(container.querySelector('input')?.disabled).toBe(false)
    // The reload restores the server value, so Save is idle rather than stuck pending.
    expect(container.querySelector('input')?.value).toBe('90')
  })
  it('says so when the project has no ledger yet', async () => {
    mocks.request.mockResolvedValue({ ledger: null })
    await render()
    expect(container.textContent).toContain('This project has no ledger yet')
    expect(saveButton()).toBeUndefined()
  })
  it('surfaces a rejected read as an alert', async () => {
    mocks.request.mockRejectedValue(new Error('Runtime unavailable'))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Runtime unavailable')
  })
})
