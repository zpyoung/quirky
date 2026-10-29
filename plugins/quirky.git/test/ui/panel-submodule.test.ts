import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { byLabel, click, entry, failure, fakeContext, layoutFor, mountPanel, q, qa, rowOf, settle, statusOf } = s

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

const submodule = { commitChanged: false, trackedChanges: true, untrackedChanges: false }

async function open(configure: (fake: ReturnType<typeof fakeContext>) => void) {
  const fake = fakeContext(layoutFor('feat'))
  fake.status = statusOf([entry('vendor/lib', 'unstaged', 'modified', { submodule })])
  configure(fake)
  const mounted = mountPanel(fake)
  await settle()
  return { fake, ...mounted }
}

describe('SC-7: submodule rows expand to their read-only changes', () => {
  test('the chevron loads submoduleStatus once and lists the entries beneath the row, with no actions', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.on('quirky.git/submoduleStatus', () => ({
        entries: [entry('x.c', 'unstaged', 'modified'), entry('src/y.c', 'untracked')]
      }))
    })
    const row = rowOf(element, 'vendor/lib')!
    expect(row.textContent).toContain('Stage inside submodule')
    expect(fake.called('quirky.git/submoduleStatus')).toHaveLength(0)

    await click(byLabel(element, 'Expand vendor/lib'))
    expect(fake.called('quirky.git/submoduleStatus').map((c) => c.params)).toEqual([{ worktree: 'feat', path: 'vendor/lib' }])
    const inside = qa(element, '[data-submodule-entry]')
    expect(inside.map((li) => q(li, '[data-row-name]')?.textContent)).toEqual(['x.c', 'y.c'])
    expect(qa(element, '[data-submodule-entry] button')).toHaveLength(0)
    expect(q(element, '[aria-label="Collapse vendor/lib"]')?.getAttribute('aria-expanded')).toBe('true')

    await click(byLabel(element, 'Collapse vendor/lib'))
    expect(qa(element, '[data-submodule-entry]')).toHaveLength(0)
    await click(byLabel(element, 'Expand vendor/lib'))
    expect(qa(element, '[data-submodule-entry]')).toHaveLength(2)
    expect(fake.called('quirky.git/submoduleStatus')).toHaveLength(1)
    expect(fake.views).toEqual([])
    unmount()
  })

  test('clicking the row expands it instead of opening a diff', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.on('quirky.git/submoduleStatus', () => ({ entries: [entry('x.c')] }))
    })
    await click(rowOf(element, 'vendor/lib'))
    expect(qa(element, '[data-submodule-entry]')).toHaveLength(1)
    expect(fake.views).toEqual([])
    unmount()
  })

  test('a failed read says so and the next expand tries again', async () => {
    let fail = true
    const { fake, element, unmount } = await open((f) => {
      f.on('quirky.git/submoduleStatus', () => {
        if (fail) throw failure('boom')
        return { entries: [] }
      })
    })
    await click(byLabel(element, 'Expand vendor/lib'))
    expect(q(element, '[data-submodule-message]')?.textContent).toBe('Could not load the submodule changes')
    await click(byLabel(element, 'Collapse vendor/lib'))
    fail = false
    await click(byLabel(element, 'Expand vendor/lib'))
    expect(q(element, '[data-submodule-message]')?.textContent).toBe('No changes inside')
    expect(fake.called('quirky.git/submoduleStatus')).toHaveLength(2)
    unmount()
  })

  test('ordinary rows have no chevron', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts')])
    })
    expect(byLabel(element, 'Expand math.ts')).toBeNull()
    unmount()
  })
})
