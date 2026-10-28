import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, entry, failure, fakeContext, layoutFor, mountPanel, q, qa, settle, statusOf, waitForState } = s

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

const primary = (element: HTMLElement) => q(element, '[data-git-primary]') as HTMLButtonElement
const dialog = () => q(document.body, '[role="dialog"]')
const dialogTitle = () => {
  const titleId = dialog()?.getAttribute('aria-labelledby')
  return titleId ? document.getElementById(titleId)?.textContent ?? null : null
}

async function menu(element: HTMLElement, label: string) {
  await click(byLabel(element, 'More commit and remote actions'))
  await click(buttonText(document.body, label))
}

describe('the primary button runs its action, then refreshes status and compare', () => {
  const cases: Array<[string, Parameters<typeof statusOf>[1], string]> = [
    ['Push', { upstreamStatus: up(2, 0) }, 'quirky.git/push'],
    ['Pull', { upstreamStatus: up(0, 1) }, 'quirky.git/pull'],
    ['Sync', { upstreamStatus: up(2, 1) }, 'quirky.git/sync'],
    ['Publish Branch', { upstreamStatus: { hasUpstream: false, name: null, sha: null, ahead: 0, behind: 0, behindPatchEquivalent: null } }, 'quirky.git/push']
  ]
  for (const [label, overrides, method] of cases) {
    test(`${label} calls ${method}`, async () => {
      const { fake, element, unmount } = await open((f) => {
        f.status = statusOf([], overrides)
      })
      if (label === 'Publish Branch') await waitForState(element, () => !primary(element).disabled)
      const before = fake.calls.length
      await click(primary(element))
      expect(fake.calls.slice(before).map((c) => c.method)).toEqual([method, 'quirky.git/status', 'quirky.git/compare'])
      expect(fake.calls[before]!.params).toEqual({ worktree: 'feat' })
      unmount()
    })
  }

  test('the menu runs Pull, Fast-forward, Rebase and Fetch', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(1, 1) })
    })
    await menu(element, 'Pull (1)')
    await menu(element, 'Fast-forward (1)')
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

  test('while the call runs the primary shows its in-flight label', async () => {
    let release: () => void = () => {}
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(2, 0) })
      f.on('quirky.git/push', () => new Promise((resolve) => (release = () => resolve({ ok: true }))))
    })
    await click(primary(element))
    expect(primary(element).title).toBe('Push in progress…')
    expect(primary(element).disabled).toBe(true)
    await act(async () => release())
    await settle()
    expect(primary(element).title).toBe('Push 2 commit(s)')
    expect(fake.called('quirky.git/push')).toHaveLength(1)
    unmount()
  })
})

describe('SC-32: a rejected push says to pull first', () => {
  test('toasts, shows the message under the button and fetches', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(1, 0) })
      f.on('quirky.git/push', () => {
        throw failure('Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.', { reason: 'non-fast-forward' })
      })
    })
    await click(primary(element))
    expect(fake.toasts).toEqual([['Push rejected — remote has changes', 'Pull first, then try again.']])
    expect(q(element, '#commit-area-remote-error')?.textContent).toContain('non-fast-forward')
    expect(fake.called('quirky.git/fetch')).toHaveLength(1)
    unmount()
  })

  test('other failures toast "<Action> failed" and a busy refusal is told as such', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(0, 1) })
      f.on('quirky.git/pull', () => {
        throw failure('A push is already running in this worktree.', { reason: 'busy' })
      })
    })
    await click(primary(element))
    expect(fake.toasts).toEqual([['Pull failed', 'A push is already running in this worktree.']])
    expect(fake.called('quirky.git/fetch')).toHaveLength(0)
    unmount()
  })

  test('a pull that stops on conflicts toasts the continue-the-merge text', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(0, 1) })
      f.on('quirky.git/pull', () => {
        throw failure('conflicts', { reason: 'conflicts' })
      })
    })
    await click(primary(element))
    expect(fake.toasts).toEqual([['Pull stopped with merge conflicts', 'Resolve them in Source Control, then continue the merge.']])
    unmount()
  })
})

describe('SC-38: a failing pre-push hook blocks the push', () => {
  test('shows the Push blocked card with a Push Failed details dialog and no inline error', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(1, 0) })
      f.on('quirky.git/push', () => {
        throw failure('Lint failed during push.', { reason: 'hook', summary: 'Lint failed during push.', output: 'lint-staged failed' })
      })
    })
    await click(primary(element))
    const card = q(element, '[role="alert"] .ui-inline-agent-card')!
    expect(card.textContent).toContain('Push blocked')
    expect(q(card, '[aria-label="Hook"]')?.textContent).toBe('Hook')
    expect(q(element, '#commit-area-remote-error')).toBeNull()
    expect(fake.toasts).toEqual([])
    await click(buttonText(card, 'Details'))
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
    expect(primary(element).textContent).toBe('Force Push')
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

  test('a stale lease toasts "Force push rejected"', async () => {
    const { fake, element, unmount } = await open((f) => {
      lease(f)
      f.on('quirky.git/forcePush', () => {
        throw failure('stale', { reason: 'stale-lease' })
      })
    })
    await click(primary(element))
    await click(buttonText(dialog()!, 'Force Push'))
    expect(fake.toasts).toEqual([['Force push rejected — remote changed since last fetch', 'Fetch first, then try again.']])
    unmount()
  })

  test('Commit & Force Push under the lease confirms, commits, then force-pushes', async () => {
    const { fake, element, unmount } = await open((f) => {
      lease(f)
      f.status = statusOf([entry('math.ts', 'staged')], { upstreamStatus: up(2, 2, true) })
    })
    const box = byLabel(element, 'Commit message') as HTMLTextAreaElement
    await s.type(box, 'msg')
    await menu(element, 'Commit & Force Push')
    await click(buttonText(dialog()!, 'Force Push'))
    expect(fake.calls.map((c) => c.method).filter((m) => m === 'quirky.git/commit' || m === 'quirky.git/forcePush')).toEqual(['quirky.git/commit', 'quirky.git/forcePush'])
    unmount()
  })
})

describe('operations', () => {
  test('Continue merge calls continue; a failure toasts "Continue merge failed"', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { operation: 'merge' })
      f.on('quirky.git/continue', () => {
        throw failure('Resolve every conflict before continuing.', { reason: 'unresolved' })
      })
    })
    await click(buttonText(element, 'Continue merge'))
    expect(fake.called('quirky.git/continue')).toHaveLength(1)
    expect(fake.toasts).toEqual([['Continue merge failed', 'Resolve every conflict before continuing.']])
    unmount()
  })

  test('SC-43: confirming Abort merge aborts with yes; a failure toasts "Abort merge failed"', async () => {
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
    expect(fake.toasts).toEqual([['Abort merge failed', 'cannot abort']])
    unmount()
  })

  test('a rebase reads "rebase" throughout', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([], { operation: 'rebase' })
    })
    expect(element.textContent).toContain('Rebase in progress')
    await click(buttonText(element, 'Abort rebase'))
    expect(dialogTitle()).toBe('Abort rebase?')
    expect(dialog()?.textContent).toContain('This cancels the rebase in progress and can discard conflict resolutions made during this rebase.')
    expect(qa(dialog()!, 'button').map((b) => b.textContent)).toEqual(['Cancel', 'Abort rebase'])
    unmount()
  })
})
