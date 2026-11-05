import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, compareOf, entry, failure, fakeContext, layoutFor, mountPanel, q, qa, settle, statusOf } = s

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

type Fake = ReturnType<typeof fakeContext>

async function open(configure: (fake: Fake) => void = () => {}) {
  const fake = fakeContext(layoutFor('feat'))
  configure(fake)
  const mounted = mountPanel(fake)
  await settle()
  return { fake, ...mounted }
}

const up = (ahead: number, behind: number, patchEquivalent: boolean | null = null) => ({
  hasUpstream: true,
  name: 'origin/zoe/feat',
  sha: 'b'.repeat(40),
  ahead,
  behind,
  behindPatchEquivalent: patchEquivalent
})

const primary = (element: HTMLElement) => q(element, '.ui-split-button__primary') as HTMLButtonElement
const errorLine = (element: HTMLElement) => q(element, '.ui-inline-error')
const menuItem = (label: string) =>
  qa(document.body, '[role="menuitem"]').find((item) => q(item, '.qt-menu-label')?.firstChild?.textContent === label) as HTMLButtonElement | undefined
const dialog = () => q(document.body, '[role="dialog"]')
const dialogTitle = () => {
  const titleId = dialog()?.getAttribute('aria-labelledby')
  return titleId ? document.getElementById(titleId)?.textContent ?? null : null
}

async function menu(element: HTMLElement, label: string) {
  await click(byLabel(element, 'More commit and remote actions'))
  await click(menuItem(label))
}

describe('the ship button runs its step, then refreshes status and compare', () => {
  const cases: Array<[string, Parameters<typeof statusOf>[1], string]> = [
    ['Push 2 commits', { upstreamStatus: up(2, 0) }, 'quirky.git/push'],
    ['Pull 1 commit', { upstreamStatus: up(0, 1) }, 'quirky.git/pull'],
    ['Sync', { upstreamStatus: up(2, 1) }, 'quirky.git/sync'],
    ['Publish branch', { upstreamStatus: { hasUpstream: false, name: null, sha: null, ahead: 0, behind: 0, behindPatchEquivalent: null } }, 'quirky.git/push']
  ]
  for (const [label, overrides, method] of cases) {
    test(`${label} calls ${method}`, async () => {
      const { fake, element, unmount } = await open((f) => {
        f.status = statusOf([], overrides)
        f.compare = compareOf({ entries: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0, binary: false }], added: 1, ahead: 1 })
      })
      expect(primary(element).textContent).toBe(label)
      const before = fake.calls.length
      await click(primary(element))
      expect(fake.calls.slice(before).map((c) => c.method)).toEqual([method, 'quirky.git/status', 'quirky.git/compare'])
      expect(fake.calls[before]!.params).toEqual({ worktree: 'feat' })
      unmount()
    })
  }

  test('the caret runs Pull, Fast-forward, Rebase and Fetch', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(0, 1) })
    })
    await menu(element, 'Pull 1 commit')
    await menu(element, 'Fast-forward')
    await menu(element, 'Rebase from origin/main')
    await menu(element, 'Fetch')
    expect(fake.calls.map((c) => c.method).filter((m) => /pull|fastForward|rebaseFromBase|fetch/.test(m))).toEqual([
      'quirky.git/pull',
      'quirky.git/fastForward',
      'quirky.git/rebaseFromBase',
      'quirky.git/fetch'
    ])
    unmount()
  })

  test('while the call runs the button is disabled and only one push is sent', async () => {
    const pending = Promise.withResolvers<{ ok: true }>()
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(2, 0) })
      f.on('quirky.git/push', () => pending.promise)
    })
    await click(primary(element))
    expect(primary(element).disabled).toBe(true)
    expect(fake.called('quirky.git/push')).toHaveLength(1)
    await act(async () => pending.resolve({ ok: true }))
    await settle()
    expect(fake.called('quirky.git/push')).toHaveLength(1)
    unmount()
  })
})

describe('SC-32: a rejected push says to pull first', () => {
  test('shows one error line with Pull first, fetches and raises no toast', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(1, 0) })
      f.on('quirky.git/push', () => {
        throw failure('Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.', { reason: 'non-fast-forward' })
      })
    })
    await click(primary(element))
    expect(fake.toasts).toEqual([])
    expect(errorLine(element)?.textContent).toContain('Push rejected: the remote has new commits')
    expect(q(errorLine(element)!, '.ui-inline-error__action')?.textContent).toBe('Pull first')
    expect(fake.called('quirky.git/fetch')).toHaveLength(1)
    unmount()
  })

  test('other failures say "<Action> failed" with the daemon message and offer Retry', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(0, 1) })
      f.on('quirky.git/pull', () => {
        throw failure('A push is already running in this worktree.', { reason: 'busy' })
      })
    })
    await click(primary(element))
    expect(errorLine(element)?.textContent).toContain('Pull failed. A push is already running in this worktree.')
    expect(q(errorLine(element)!, '.ui-inline-error__action')?.textContent).toBe('Retry')
    expect(fake.toasts).toEqual([])
    expect(fake.called('quirky.git/fetch')).toHaveLength(0)
    unmount()
  })

  test('a pull that stops on conflicts tells the person to continue the merge', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(0, 1) })
      f.on('quirky.git/pull', () => {
        throw failure('conflicts', { reason: 'conflicts' })
      })
    })
    await click(primary(element))
    expect(errorLine(element)?.textContent).toContain('Pull stopped with merge conflicts. Resolve them in Source Control, then continue the merge.')
    expect(q(errorLine(element)!, '.ui-inline-error__action')).toBeNull()
    expect(fake.toasts).toEqual([])
    unmount()
  })

  test('a push while the GitHub lookup is unavailable reports why in the line', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(1, 0) })
      f.on('quirky.hosting/forBranch', () => ({ kind: 'unavailable', message: 'gh is not signed in' }))
    })
    await click(primary(element))
    expect(errorLine(element)?.textContent).toContain('gh is not signed in')
    expect(fake.called('quirky.git/push')).toHaveLength(0)
    expect(fake.toasts).toEqual([])
    unmount()
  })
})

describe('SC-38: a failing pre-push hook blocks the push', () => {
  test('shows the hook summary in the error line with a Push Failed details dialog and no toast', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(1, 0) })
      f.on('quirky.git/push', () => {
        throw failure('Lint failed during push.', { reason: 'hook', summary: 'Lint failed during push.', output: 'lint-staged failed' })
      })
    })
    await click(primary(element))
    expect(errorLine(element)?.textContent).toContain('Lint failed during push.')
    expect(fake.toasts).toEqual([])
    await click(q(errorLine(element)!, '.ui-inline-error__action'))
    expect(dialogTitle()).toBe('Push Failed')
    expect(q(dialog()!, 'pre')?.textContent).toBe('lint-staged failed')
    unmount()
  })
})

describe('force push', () => {
  const lease = (f: Fake) => {
    f.status = statusOf([], { upstreamStatus: up(2, 2, true) })
    f.on('quirky.git/describeForcePush', () => 'Force push zoe/feat to origin? This replaces the remote branch with your local commits.')
  }

  test('the primary asks with the describe text, then force-pushes with yes and the expected sha', async () => {
    const { fake, element, unmount } = await open(lease)
    expect(primary(element).textContent).toBe('Force push 2 commits')
    await click(primary(element))
    expect(dialogTitle()).toBe('Force push zoe/feat to origin?')
    expect(dialog()?.textContent).toContain('This replaces the remote branch with your local commits.')
    expect(fake.called('quirky.git/forcePush')).toHaveLength(0)
    await click(buttonText(dialog()!, 'Force Push'))
    expect(fake.called('quirky.git/forcePush').at(-1)?.params).toEqual({ worktree: 'feat', yes: true, expected: 'b'.repeat(40) })
    unmount()
  })

  test('cancelling sends nothing', async () => {
    const { fake, element, unmount } = await open(lease)
    await click(primary(element))
    await click(buttonText(dialog()!, 'Cancel'))
    expect(fake.called('quirky.git/forcePush')).toHaveLength(0)
    unmount()
  })

  test('a stale lease puts "Force push rejected" in the error line with Fetch first', async () => {
    const { fake, element, unmount } = await open((f) => {
      lease(f)
      f.on('quirky.git/forcePush', () => {
        throw failure('stale', { reason: 'stale-lease' })
      })
    })
    await click(primary(element))
    await click(buttonText(dialog()!, 'Force Push'))
    expect(errorLine(element)?.textContent).toContain('Force push rejected: the remote changed since the last fetch')
    expect(q(errorLine(element)!, '.ui-inline-error__action')?.textContent).toBe('Fetch first')
    expect(fake.toasts).toEqual([])
    unmount()
  })

  test('Commit & push under the lease confirms, commits, then force-pushes', async () => {
    const { fake, element, unmount } = await open((f) => {
      lease(f)
      f.status = statusOf([entry('math.ts', 'staged')], { upstreamStatus: up(2, 2, true) })
    })
    const box = byLabel(element, 'Commit message') as HTMLTextAreaElement
    await s.type(box, 'msg')
    await menu(element, 'Commit & push')
    await click(buttonText(dialog()!, 'Force Push'))
    expect(fake.calls.map((c) => c.method).filter((m) => m === 'quirky.git/commit' || m === 'quirky.git/forcePush')).toEqual(['quirky.git/commit', 'quirky.git/forcePush'])
    unmount()
  })
})

describe('operations', () => {
  test('Continue merge calls continue; a failure shows "Continue merge failed" in the error line', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { operation: 'merge' })
      f.on('quirky.git/continue', () => {
        throw failure('Resolve every conflict before continuing.', { reason: 'unresolved' })
      })
    })
    await click(buttonText(element, 'Continue merge'))
    expect(fake.called('quirky.git/continue')).toHaveLength(1)
    expect(errorLine(element)?.textContent).toContain('Continue merge failed. Resolve every conflict before continuing.')
    expect(fake.toasts).toEqual([])
    unmount()
  })

  test('SC-43: confirming Abort merge aborts with yes; a failure shows "Abort merge failed" in the error line', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { operation: 'merge' })
      f.on('quirky.git/abort', () => {
        throw failure('cannot abort')
      })
    })
    await click(buttonText(element, 'Abort merge'))
    expect(dialogTitle()).toBe('Abort merge?')
    await click(buttonText(dialog()!, 'Cancel'))
    expect(fake.called('quirky.git/abort')).toHaveLength(0)
    await click(buttonText(element, 'Abort merge'))
    await click(buttonText(dialog()!, 'Abort merge'))
    expect(fake.called('quirky.git/abort').at(-1)?.params).toEqual({ worktree: 'feat', yes: true })
    expect(errorLine(element)?.textContent).toContain('Abort merge failed. cannot abort')
    expect(fake.toasts).toEqual([])
    unmount()
  })

  test('aborting a rebase can be cancelled or confirmed', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { operation: 'rebase' })
    })
    await click(buttonText(element, 'Abort rebase'))
    expect(dialog()).not.toBeNull()
    await click(buttonText(dialog()!, 'Cancel'))
    expect(dialog()).toBeNull()
    expect(fake.called('quirky.git/abort')).toHaveLength(0)
    await click(buttonText(element, 'Abort rebase'))
    await click(buttonText(dialog()!, 'Abort rebase'))
    expect(fake.called('quirky.git/abort').at(-1)?.params).toEqual({ worktree: 'feat', yes: true })
    unmount()
  })
})
