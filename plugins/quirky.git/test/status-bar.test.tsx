import { afterAll, beforeEach, describe, expect, jest, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './ui/register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./ui/panel-support')
const { act, click, entry, failure, fakeContext, layoutFor, settle, statusOf } = s
const { activate } = await import('../src/ui')

const ITEM = 'status-bar:quirky.git/ahead-behind'
const PANEL_ID = 'panel:quirky.git/source-control'

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

type Mount = (element: HTMLElement, props: Record<string, never>) => (() => void) | void

function mountItem(fake: ReturnType<typeof fakeContext>): { element: HTMLElement; unmount: () => void } {
  let mount: Mount | undefined
  const provide = fake.context.provide
  fake.context.provide = (id, implementation) => {
    provide(id, implementation)
    if (id === ITEM) mount = implementation as Mount
  }
  void activate(fake.context)
  if (!mount) throw new Error(`activate did not provide ${ITEM}`)
  const element = document.createElement('div')
  document.body.appendChild(element)
  let cleanup: (() => void) | void
  act(() => {
    cleanup = mount!(element, {})
  })
  return {
    element,
    unmount: () => {
      act(() => {
        cleanup?.()
      })
      element.remove()
    }
  }
}

// bun's runtime has this; its typings omit it
const advance = (ms: number) => (jest as unknown as { advanceTimersByTime(ms: number): void }).advanceTimersByTime(ms)

const popup = () => document.querySelector('.ui-popup')
const rows = () => [...document.querySelectorAll('.ui-popup [role="menuitem"]')].map((row) => row.textContent ?? '')
const statusCalls = (fake: ReturnType<typeof fakeContext>) => fake.called('quirky.git/status')

describe('quirky.git ahead and behind status bar item', () => {
  test('the manifest declares the item at order 10 and activate provides it', async () => {
    const manifest = await Bun.file(new URL('../quirky-plugin.json', import.meta.url)).json()
    expect(manifest.contributes['status-bar']).toEqual([{ id: 'ahead-behind', title: 'Ahead and behind', order: 10 }])
    const fake = fakeContext(layoutFor('fix-login'))
    const provided: string[] = []
    fake.context.provide = (id) => void provided.push(id)
    void activate(fake.context)
    expect(provided).toContain(ITEM)
  })

  test('it shows the commits ahead and behind and opens a popup titled with the branch that ends with the Changes link', async () => {
    const fake = fakeContext(layoutFor('fix-login'))
    fake.status = statusOf([entry('a.ts')], { branch: 'zoe/feat', upstream: 'origin/zoe/feat', ahead: 2, behind: 1 })
    const opened: Array<[string, boolean | undefined]> = []
    fake.context.togglePanel = (id, open) => void opened.push([id, open])
    const { element, unmount } = mountItem(fake)
    await settle()

    const button = element.querySelector('button')!
    expect(button.textContent).toBe('↑2 ↓1')
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(statusCalls(fake)[0]).toEqual({ method: 'quirky.git/status', params: { worktree: 'fix-login' } })

    await click(button)
    expect(popup()?.querySelector('.ui-popup__title')?.textContent).toBe('zoe/feat')
    expect(rows().at(-1)).toBe('Open the Changes panel')
    expect(rows()[0]).toContain('2 commits to push to origin/zoe/feat')
    expect(rows()[1]).toContain('1 commit to pull from origin/zoe/feat')

    await click([...document.querySelectorAll('.ui-popup [role="menuitem"]')].at(-1))
    expect(opened).toEqual([[PANEL_ID, true]])
    expect(popup()).toBeNull()
    unmount()
  })

  test('it is hidden without an upstream, when status is unavailable and with no worktree', async () => {
    const noUpstream = fakeContext(layoutFor('fix-login'))
    noUpstream.status = statusOf([], { upstream: null, ahead: 0, behind: 0 })
    const first = mountItem(noUpstream)
    await settle()
    expect(first.element.textContent).toBe('')
    first.unmount()

    const unavailable = fakeContext(layoutFor('fix-login'))
    unavailable.on('quirky.git/status', () => {
      throw failure('this workspace is a folder', { reason: 'folder-workspace' })
    })
    const second = mountItem(unavailable)
    await settle()
    expect(second.element.textContent).toBe('')
    second.unmount()

    const none = fakeContext(layoutFor(null))
    const third = mountItem(none)
    await settle()
    expect(third.element.textContent).toBe('')
    expect(statusCalls(none)).toHaveLength(0)
    third.unmount()
  })

  test('it reads status no more than every 10 seconds while mounted, and stops after unmount', async () => {
    jest.useFakeTimers()
    try {
      const fake = fakeContext(layoutFor('fix-login'))
      fake.status = statusOf([], { ahead: 1, behind: 0 })
      const { unmount } = mountItem(fake)
      await settle()
      expect(statusCalls(fake)).toHaveLength(1)

      await act(async () => {
        advance(9_999)
      })
      expect(statusCalls(fake)).toHaveLength(1)
      await act(async () => {
        advance(1)
      })
      await settle()
      expect(statusCalls(fake)).toHaveLength(2)
      await act(async () => {
        advance(10_000)
      })
      await settle()
      expect(statusCalls(fake)).toHaveLength(3)

      unmount()
      await act(async () => {
        advance(60_000)
      })
      expect(statusCalls(fake)).toHaveLength(3)
    } finally {
      jest.useRealTimers()
    }
  })

  test('it reads again on this worktree\'s git events and follows the selected worktree', async () => {
    const fake = fakeContext(layoutFor('one'))
    fake.statuses.one = statusOf([], { ahead: 1, behind: 0, branch: 'one-branch' })
    fake.statuses.two = statusOf([], { ahead: 0, behind: 4, branch: 'two-branch' })
    const { element, unmount } = mountItem(fake)
    await settle()
    expect(element.textContent).toBe('↑1 ↓0')

    fake.statuses.one = statusOf([], { ahead: 3, behind: 0, branch: 'one-branch' })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'other' } }))
    await settle()
    expect(statusCalls(fake)).toHaveLength(1)
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'one' } }))
    await settle()
    expect(element.textContent).toBe('↑3 ↓0')

    await act(async () => fake.setLayout(layoutFor('two')))
    await settle()
    expect(element.textContent).toBe('↑0 ↓4')
    expect(statusCalls(fake).at(-1)?.params).toEqual({ worktree: 'two' })
    unmount()
  })
})
