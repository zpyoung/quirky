import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { CleanupCandidate } from '../src/control-types'

type CleanupDialogType = typeof import('../src/CleanupDialog').CleanupDialog

let CleanupDialog: CleanupDialogType
let createRoot: typeof import('react-dom/client').createRoot
let root: Root | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  CleanupDialog = (await import('../src/CleanupDialog')).CleanupDialog
  createRoot = (await import('react-dom/client')).createRoot
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const candidate = (overrides: Partial<CleanupCandidate> & { worktreeId: string }): CleanupCandidate => ({
  name: overrides.worktreeId,
  fingerprint: `fp-${overrides.worktreeId}`,
  reason: 'archived-7day',
  ignored: false,
  eligible: true,
  blockers: [],
  ...overrides
})

async function mount(candidates: CleanupCandidate[], confirm: (options: { title: string; body: string; confirmLabel?: string }) => Promise<boolean> = async () => true) {
  const calls: Array<{ method: string; params: unknown }> = []
  const confirms: Array<{ title: string; body: string; confirmLabel?: string }> = []
  const context = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === 'quirky.worktree/cleanupPreview') return { generatedAt: 1, candidates }
      if (method === 'quirky.worktree/cleanupRemove') return { results: [] }
      return undefined
    },
    confirm: async (options: { title: string; body: string; confirmLabel?: string }) => {
      confirms.push(options)
      return confirm(options)
    }
  } as unknown as UiPluginContext
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(CleanupDialog, { context, onClose: () => {} }))
  })
  await act(async () => { await Promise.resolve() })
  return { calls, confirms }
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const button = (label: string) => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === label)
const click = (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })

test('each row shows its reason in plain words and never a raw code', async () => {
  await mount([
    candidate({ worktreeId: 'old-experiment', reason: 'archived-7day' }),
    candidate({ worktreeId: 'dusty', reason: 'idle-clean' })
  ])
  const text = dialog().textContent ?? ''
  expect(text).toContain('Archived over 7 days ago, no unpushed work')
  expect(text).toContain('Idle for at least 30 days')
  expect(text).not.toContain('archived-7day')
  expect(text).not.toContain('idle-clean')
})

test('blockers stay listed under their row', async () => {
  await mount([candidate({ worktreeId: 'busy', eligible: false, blockers: [{ code: 'unpushed', detail: '2 commits not pushed' }] })])
  expect(dialog().textContent).toContain('2 commits not pushed')
  expect(dialog().textContent).not.toContain('no unpushed work')
  const checkbox = dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(checkbox.disabled).toBe(true)
})

test('an empty preview says nothing needs cleaning and what qualifies', async () => {
  await mount([])
  const text = dialog().textContent ?? ''
  expect(text).toContain('Nothing to clean up')
  expect(text).toContain('Worktrees archived for 7 days or more with nothing unpushed')
  expect(text).not.toContain('No idle cleanup candidates')
})

test('the header offers Refresh preview and Restore ignored, and rows offer Ignore', async () => {
  await mount([candidate({ worktreeId: 'old-experiment' })])
  expect(button('Refresh preview')).toBeDefined()
  expect(button('Restore ignored')).toBeDefined()
  expect(button('Ignore')).toBeDefined()
})

test('Delete selected confirms with the count of selected worktrees', async () => {
  const { confirms, calls } = await mount([
    candidate({ worktreeId: 'one' }),
    candidate({ worktreeId: 'two' }),
    candidate({ worktreeId: 'three' })
  ])
  const boxes = [...dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  await click(boxes[0]!)
  await click(boxes[1]!)
  await click(button('Delete selected')!)
  expect(confirms).toHaveLength(1)
  expect(confirms[0]!.title).toBe('Delete 2 worktrees?')
  expect(calls.some((call) => call.method === 'quirky.worktree/cleanupRemove')).toBe(true)
})

test('the confirm uses the singular for one worktree', async () => {
  const { confirms } = await mount([candidate({ worktreeId: 'solo' })])
  await click(dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!)
  await click(button('Delete selected')!)
  expect(confirms[0]!.title).toBe('Delete 1 worktree?')
})
