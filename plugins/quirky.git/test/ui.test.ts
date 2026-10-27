import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './ui/register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./ui/panel-support')
const { act, byLabel, buttonText, click, DIFF_VIEW, entry, failure, fakeContext, layoutFor, mountPanel, PANEL, q, rowOf, settle, statusOf, type } = s
const { activate } = await import('../src/ui')

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

const fixture = () =>
  statusOf([entry('staged.ts', 'staged'), entry('edited.ts', 'unstaged'), entry('new.txt', 'untracked')])

describe('quirky.git source-control panel', () => {
  test('SC-36: the manifest points at the built module and declares the panel activate provides', async () => {
    const manifest = await Bun.file(new URL('../quirky-plugin.json', import.meta.url)).json()
    expect(manifest.ui).toBe('dist/ui.js')
    expect(manifest.contributes.panel.map((p: { id: string }) => `panel:${manifest.id}/${p.id}`)).toEqual([PANEL])
  })

  test('SC-36: activate provides exactly the panel, view and commands the manifest declares', async () => {
    const manifest = await Bun.file(new URL('../quirky-plugin.json', import.meta.url)).json()
    const declared = (['panel', 'view', 'command'] as const).flatMap((kind) =>
      (manifest.contributes[kind] as { id: string }[]).map((c) => `${kind}:${manifest.id}/${c.id}`)
    )
    const fake = fakeContext(layoutFor(null))
    const provided: string[] = []
    fake.context.provide = (id) => void provided.push(id)
    void activate(fake.context)
    expect(provided).toContain(PANEL)
    expect([...provided].sort()).toEqual([...declared].sort())
  })

  test('SC-36: with no worktree open it asks for one and reports nothing selected', async () => {
    const fake = fakeContext(layoutFor(null))
    const { element, unmount } = mountPanel(fake)
    await settle()
    expect(element.textContent).toContain('Select a workspace to view changes')
    expect(fake.calls).toEqual([])
    expect(fake.reports.at(-1)).toMatchObject({ worktree: null, branch: null, sections: [], primary: null })
    unmount()
  })

  test('SC-36: it shows the changes of the worktree in the open view and reports them', async () => {
    const fake = fakeContext(layoutFor('fix-login'))
    fake.status = fixture()
    const { element, unmount } = mountPanel(fake)
    await settle()
    expect(fake.calls[0]).toEqual({ method: 'quirky.git/status', params: { worktree: 'fix-login' } })
    expect(element.textContent).toContain('Staged Changes')
    expect(element.textContent).toContain('staged.ts')
    expect(element.textContent).toContain('zoe/feat')
    expect(fake.reports.at(-1)).toMatchObject({
      worktree: 'fix-login',
      branch: 'zoe/feat',
      sections: [
        { id: 'unstaged', count: 1 },
        { id: 'staged', count: 1 },
        { id: 'untracked', count: 1 }
      ]
    })
    unmount()
  })

  test('SC-36: opening another worktree swaps the panel to it', async () => {
    const fake = fakeContext(layoutFor('one'))
    fake.status = fixture()
    fake.statuses.two = statusOf([], { branch: 'feature' })
    const { element, unmount } = mountPanel(fake)
    await settle()
    await act(async () => fake.setLayout(layoutFor('two')))
    await settle()
    expect(fake.called('quirky.git/status').at(-1)?.params).toEqual({ worktree: 'two' })
    expect(element.textContent).toContain('No changes on this branch')
    expect(fake.reports.at(-1)).toMatchObject({ worktree: 'two', branch: 'feature', sections: [] })
    await act(async () => fake.setLayout(layoutFor(null)))
    await settle()
    expect(element.textContent).toContain('Select a workspace to view changes')
    expect(fake.badges.at(-1)?.[1]).toBeNull()
    unmount()
  })

  test('refreshes on quirky.git/changed for this worktree and ignores other events', async () => {
    const fake = fakeContext(layoutFor('w1'))
    const { unmount } = mountPanel(fake)
    await settle()
    const before = fake.calls.length
    await act(async () => fake.emit({ type: 'quirky.session/changed', data: {} }))
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'someone-else' } }))
    await settle()
    expect(fake.calls.length).toBe(before)
    fake.status = statusOf([])
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(fake.calls.slice(before).map((c) => c.method)).toEqual(['quirky.git/status'])
    unmount()
  })

  test('keeps polling status every 3 seconds and compare every 30', async () => {
    const intervals: number[] = []
    const realSetInterval = globalThis.setInterval
    globalThis.setInterval = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 3000 || ms === 30_000) intervals.push(ms)
      return (realSetInterval as (...args: unknown[]) => unknown)(handler, ms, ...rest)
    }) as typeof setInterval
    try {
      const { unmount } = mountPanel(fakeContext(layoutFor('w1')))
      await settle()
      unmount()
    } finally {
      globalThis.setInterval = realSetInterval
    }
    expect(intervals).toEqual([3000, 30_000])
  })

  test('stages a file, then refetches status', async () => {
    const fake = fakeContext(layoutFor('w1'))
    fake.status = fixture()
    const { element, unmount } = mountPanel(fake)
    await settle()
    const before = fake.calls.length
    await click(byLabel(element, 'Stage edited.ts'))
    expect(fake.calls.slice(before)).toEqual([
      { method: 'quirky.git/stage', params: { worktree: 'w1', paths: ['edited.ts'] } },
      { method: 'quirky.git/status', params: { worktree: 'w1' } },
      { method: 'quirky.git/compare', params: { worktree: 'w1' } }
    ])
    unmount()
  })

  test('unstages all staged files', async () => {
    const fake = fakeContext(layoutFor('w1'))
    fake.status = fixture()
    const { element, unmount } = mountPanel(fake)
    await settle()
    await click(byLabel(element, 'Unstage all'))
    expect(fake.called('quirky.git/unstage').at(-1)?.params).toEqual({ worktree: 'w1', paths: ['staged.ts'] })
    unmount()
  })

  test('a failed stage shows a notice and the panel stays up', async () => {
    const fake = fakeContext(layoutFor('w1'))
    fake.status = fixture()
    fake.on('quirky.git/stage', () => {
      throw new Error('quirky.git/stage refused')
    })
    const { element, unmount } = mountPanel(fake)
    await settle()
    await click(byLabel(element, 'Stage edited.ts'))
    expect(q(element, '.notice')?.textContent).toContain('quirky.git/stage refused')
    expect(element.textContent).toContain('edited.ts')
    unmount()
  })

  test('commits the staged changes with the typed message', async () => {
    const fake = fakeContext(layoutFor('w1'))
    fake.status = fixture()
    const { element, unmount } = mountPanel(fake)
    await settle()
    const box = byLabel(element, 'Commit message') as HTMLTextAreaElement
    const commitButton = () => buttonText(element, 'Commit')
    expect(commitButton()?.disabled).toBe(true)
    await type(box, '  fix the login  ')
    await click(commitButton())
    expect(fake.called('quirky.git/commit').at(-1)?.params).toEqual({ worktree: 'w1', message: 'fix the login' })
    expect(box.value).toBe('')
    unmount()
  })

  test('clicking a row opens the diff view with this input', async () => {
    const fake = fakeContext(layoutFor('w1'))
    fake.status = fixture()
    const { element, unmount } = mountPanel(fake)
    await settle()
    await click(rowOf(element, 'edited.ts'))
    expect(fake.views).toEqual([{ id: DIFF_VIEW, input: { worktree: 'w1', mode: 'file', source: 'unstaged', path: 'edited.ts' } }])
    expect(fake.calls.some((c) => c.method === 'quirky.git/diff')).toBe(false)
    expect(q(element, '.diff-host')).toBeNull()
    unmount()
  })

  test('SC-13: a folder workspace shows the unavailable sentence, with no changes or commit box', async () => {
    const fake = fakeContext(layoutFor('wt_notes'))
    const sentence = 'Opened as folder. Git features are unavailable for this workspace.'
    fake.on('quirky.git/status', () => {
      throw failure(sentence, { reason: 'folder-workspace' })
    })
    const { element, unmount } = mountPanel(fake)
    await settle()
    expect(q(element, '.scm-unavailable')?.textContent).toBe(sentence)
    expect(q(element, '.scm-error')).toBeNull()
    expect(q(element, 'textarea')).toBeNull()
    expect(element.textContent).not.toContain('Staged')
    unmount()
  })

  test('a failing status read shows the error and keeps the last good rows', async () => {
    const fake = fakeContext(layoutFor('w1'))
    fake.status = fixture()
    const { element, unmount } = mountPanel(fake)
    await settle()
    fake.on('quirky.git/status', () => {
      throw new Error('git is gone')
    })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(q(element, '.scm-error')?.textContent).toBe('git is gone')
    expect(rowOf(element, 'edited.ts')).not.toBeNull()
    unmount()
  })

  test('closing the panel unsubscribes from events and layout', async () => {
    const fake = fakeContext(layoutFor('w1'))
    const { unmount } = mountPanel(fake)
    await settle()
    expect(fake.listeners().events).toBeGreaterThan(0)
    unmount()
    expect(fake.listeners()).toEqual({ events: 0, layout: 0 })
  })
})
