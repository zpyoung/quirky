import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, compareOf, entry, failure, fakeContext, layoutFor, mountPanel, press, q, qa, rowOf, settle, statusOf, type } = s

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

const upstream = (ahead: number, behind: number, patchEquivalent: boolean | null = null) => ({
  hasUpstream: true,
  name: 'origin/zoe/feat',
  sha: 'b'.repeat(40),
  ahead,
  behind,
  behindPatchEquivalent: patchEquivalent
})

const primary = (element: HTMLElement) => q(element, '.scm-primary') as HTMLButtonElement
const chevron = (element: HTMLElement) => byLabel(element, 'More commit and remote actions') as HTMLButtonElement
const dialog = () => q(document.body, '[role="dialog"]')
const menuLabels = () => qa(document.body, '[role="menu"] button').map((b) => b.textContent)
const message = (element: HTMLElement) => byLabel(element, 'Commit message') as HTMLTextAreaElement

describe('SC-23: the discard dialogs', () => {
  const rows = (fake: Fake) => {
    fake.status = statusOf([
      entry('math.ts', 'unstaged'),
      entry('gone.ts', 'unstaged', 'deleted'),
      entry('notes.txt', 'untracked'),
      entry('b.txt', 'untracked'),
      entry('c.txt', 'untracked'),
      entry('README.md', 'staged')
    ])
  }

  const cases: Array<[string, string, string, string, string, string]> = [
    ['unstaged', 'math.ts', 'Discard changes', 'Discard changes to "math.ts"?', 'This will revert the unstaged changes to this file. This cannot be undone.', 'Discard'],
    ['unstaged', 'gone.ts', 'Restore file', 'Restore "gone.ts"?', 'This will restore the last staged version and discard the deletion. This cannot be undone.', 'Restore'],
    ['untracked', 'notes.txt', 'Delete untracked file', 'Delete "notes.txt"?', 'This will permanently delete this file. This cannot be undone.', 'Delete']
  ]
  for (const [section, path, button, title, body, confirm] of cases) {
    test(`${button} on ${path} asks "${title}" with focus on ${confirm}, then discards with yes`, async () => {
      const { fake, element, unmount } = await open(rows)
      await click(byLabel(element, `${button} ${path}`))
      expect(dialog()?.getAttribute('aria-label')).toBe(title)
      expect(dialog()?.querySelector('.dialog-message')?.textContent).toBe(body)
      const confirmButton = buttonText(dialog()!, confirm)!
      expect(document.activeElement).toBe(confirmButton)
      expect(fake.called('quirky.git/discard')).toHaveLength(0)
      await click(confirmButton)
      expect(fake.called('quirky.git/discard').at(-1)?.params).toEqual({ worktree: 'feat', paths: [path], yes: true })
      expect(section).toBeTruthy()
      unmount()
    })
  }

  test('Discard all on each section asks with Orca\'s text and sends the area', async () => {
    const { fake, element, unmount } = await open(rows)
    const askFor = async (section: string, label: string, title: string, confirm: string) => {
      await click(byLabel(q(element, `[data-section="${section}"]`)!, label))
      expect(dialog()?.getAttribute('aria-label')).toBe(title)
      await click(buttonText(dialog()!, confirm))
    }
    await askFor('untracked', 'Delete all untracked', 'Delete 3 untracked files?', 'Delete 3')
    await askFor('staged', 'Discard all', 'Discard all staged changes?', 'Discard all')
    await askFor('unstaged', 'Discard all', 'Discard all unstaged changes?', 'Discard all')
    expect(fake.called('quirky.git/discard').map((c) => c.params)).toEqual([
      { worktree: 'feat', area: 'untracked', yes: true },
      { worktree: 'feat', area: 'staged', yes: true },
      { worktree: 'feat', area: 'unstaged', yes: true }
    ])
    unmount()
  })

  test('Cancel changes nothing and Escape cancels too', async () => {
    const { fake, element, unmount } = await open(rows)
    await click(byLabel(element, 'Discard changes math.ts'))
    await click(buttonText(dialog()!, 'Cancel'))
    expect(dialog()).toBeNull()
    await click(byLabel(element, 'Discard changes math.ts'))
    await press(window, 'Escape')
    expect(dialog()).toBeNull()
    expect(fake.called('quirky.git/discard')).toHaveLength(0)
    unmount()
  })
})

describe('unstaging a rename', () => {
  test('sends both the new and the old path', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('new.ts', 'staged', 'renamed', { oldPath: 'old.ts' })])
    })
    await click(byLabel(element, 'Unstage new.ts'))
    expect(fake.called('quirky.git/unstage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['new.ts', 'old.ts'] })
    unmount()
  })
})

describe('SC-24: stage and discard failures show one notice with Retry', () => {
  test('a row failure shows the notice with Retry, replaced rather than stacked', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'unstaged')])
      f.on('quirky.git/discard', () => {
        throw new Error('EACCES: permission denied')
      })
    })
    for (let i = 0; i < 2; i++) {
      await click(byLabel(element, 'Discard changes math.ts'))
      await click(buttonText(dialog()!, 'Discard'))
    }
    const notices = qa(element, '.notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.textContent).toContain('Failed to discard “math.ts”')
    expect(notices[0]!.textContent).toContain('EACCES: permission denied')
    expect(buttonText(notices[0]!, 'Retry')).toBeDefined()
    expect(fake.toasts).toEqual([])
    unmount()
  })

  test('Retry repeats the action; after 10 seconds only Dismiss remains', async () => {
    const real = globalThis.setTimeout
    const delays: Array<() => void> = []
    globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 10_000) {
        delays.push(handler)
        return 0
      }
      return (real as (...args: unknown[]) => unknown)(handler, ms, ...rest)
    }) as typeof setTimeout
    try {
      let fail = true
      const { fake, element, unmount } = await open((f) => {
        f.status = statusOf([entry('math.ts', 'unstaged')])
        f.on('quirky.git/stage', () => {
          if (fail) throw new Error('index locked')
          return { ok: true }
        })
      })
      await click(byLabel(element, 'Stage math.ts'))
      expect(element.querySelector('.notice')?.textContent).toContain('Failed to stage “math.ts”')
      await act(async () => delays.forEach((run) => run()))
      expect(buttonText(element.querySelector('.notice')!, 'Retry')).toBeUndefined()
      expect(buttonText(element.querySelector('.notice')!, 'Dismiss')).toBeDefined()
      await click(buttonText(element.querySelector('.notice')!, 'Dismiss'))
      expect(element.querySelector('.notice')).toBeNull()
      fail = false
      expect(fake.called('quirky.git/stage')).toHaveLength(1)
      unmount()
    } finally {
      globalThis.setTimeout = real
    }
  })

  test('Retry runs the failed call again', async () => {
    let fail = true
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'unstaged')])
      f.on('quirky.git/stage', () => {
        if (fail) throw new Error('index locked')
        return { ok: true }
      })
    })
    await click(byLabel(element, 'Stage math.ts'))
    fail = false
    await click(buttonText(element.querySelector('.notice')!, 'Retry'))
    expect(fake.called('quirky.git/stage')).toHaveLength(2)
    expect(element.querySelector('.notice')).toBeNull()
    unmount()
  })

  test('a bulk discard where files fail shows the count, the first message and up to three paths', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf(['a.ts', 'b.ts', 'c.ts'].map((p) => entry(p, 'unstaged')))
      f.on('quirky.git/discard', () => {
        throw failure('Failed to discard 2 file(s)', {
          failures: [
            { path: 'a.ts', message: 'read-only' },
            { path: 'b.ts', message: 'read-only' }
          ]
        })
      })
    })
    await click(byLabel(q(element, '[data-section="unstaged"]')!, 'Discard all'))
    await click(buttonText(dialog()!, 'Discard all'))
    const notice = q(element, '.notice')!
    expect(notice.textContent).toContain('Failed to discard 2 file(s)')
    expect(notice.textContent).toContain('read-only a.ts, b.ts')
    unmount()
  })

  test('a notice for a worktree the person has left gains the worktree name and loses Retry', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'unstaged')])
      f.statuses.other = statusOf([])
      f.on('quirky.git/stage', () => {
        throw new Error('index locked')
      })
    })
    await click(byLabel(element, 'Stage math.ts'))
    await act(async () => fake.setLayout(layoutFor('other')))
    await settle()
    const notice = q(element, '.notice')!
    expect(notice.textContent).toContain('Failed to stage “math.ts” in feat')
    expect(buttonText(notice, 'Retry')).toBeUndefined()
    unmount()
  })
})

describe('SC-25: the commit box', () => {
  test('with nothing staged the primary reads Stage All; staged and untyped it is a disabled Commit', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'unstaged')])
    })
    expect(primary(element).textContent).toBe('Stage All')
    expect(primary(element).disabled).toBe(false)
    await click(primary(element))
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['math.ts'] })
    fake.status = statusOf([entry('math.ts', 'staged')])
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    expect(primary(element).textContent).toBe('Commit')
    expect(primary(element).disabled).toBe(true)
    expect(primary(element).title).toBe('Enter a commit message to commit')
    unmount()
  })

  test('Cmd+Enter commits with the trimmed message, clears the box and refreshes status and compare', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
    })
    await type(message(element), '  fix the login  ')
    expect(primary(element).title).toBe('Commit staged changes')
    const before = fake.calls.length
    await press(message(element), 'Enter', { metaKey: true })
    expect(fake.calls.slice(before).map((c) => c.method)).toEqual(['quirky.git/commit', 'quirky.git/status', 'quirky.git/compare'])
    expect(fake.called('quirky.git/commit').at(-1)?.params).toEqual({ worktree: 'feat', message: 'fix the login' })
    expect(message(element).value).toBe('')
    unmount()
  })

  test('Cmd+Enter does nothing when the primary is not an enabled Commit', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'unstaged')])
    })
    await press(element.querySelector('.scm')!, 'Enter', { metaKey: true })
    expect(fake.called('quirky.git/commit')).toHaveLength(0)
    unmount()
  })

  test('the box grows with its lines, from 2 to 12 rows', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
    })
    expect(Number(message(element).rows)).toBe(2)
    await type(message(element), 'a\nb\nc\nd')
    expect(Number(message(element).rows)).toBe(4)
    await type(message(element), 'x\n'.repeat(30))
    expect(Number(message(element).rows)).toBe(12)
    unmount()
  })

  test('the box is locked when nothing is staged and keeps a draft per worktree', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
      f.statuses.other = statusOf([entry('x.ts', 'staged')])
    })
    await type(message(element), 'draft one')
    await act(async () => fake.setLayout(layoutFor('other')))
    await settle()
    expect(message(element).value).toBe('')
    await act(async () => fake.setLayout(layoutFor('feat')))
    await settle()
    expect(message(element).value).toBe('draft one')
    fake.status = statusOf([entry('math.ts', 'unstaged')])
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    expect(message(element).disabled).toBe(true)
    unmount()
  })

  test('a failed commit toasts "Commit failed" and keeps the message', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
      f.on('quirky.git/commit', () => {
        throw failure('fatal: nope', { reason: 'failed' })
      })
    })
    await type(message(element), 'msg')
    await click(primary(element))
    expect(fake.toasts).toEqual([['Commit failed', 'fatal: nope']])
    expect(message(element).value).toBe('msg')
    unmount()
  })
})

describe('SC-27: a failing hook blocks the commit', () => {
  test('shows Commit blocked with a Lint pill, the summary and Details with the raw output', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
      f.on('quirky.git/commit', () => {
        throw failure('Lint failed during commit.', { reason: 'lint', summary: 'Lint failed during commit.', output: 'eslint found 2 problems' })
      })
    })
    await type(message(element), 'Add math')
    await click(primary(element))
    const card = q(element, '.scm-card-blocked')!
    expect(card.textContent).toContain('Commit blocked')
    expect(q(card, '.scm-pill')?.textContent).toBe('Lint')
    expect(q(card, '.scm-summary')?.textContent).toBe('Lint failed during commit.')
    expect(fake.toasts).toEqual([])
    await click(buttonText(card, 'Details'))
    expect(dialog()?.getAttribute('aria-label')).toBe('Commit Failed')
    expect(q(dialog()!, 'pre')?.textContent).toBe('eslint found 2 problems')
    await click(buttonText(dialog()!, 'Close'))
    expect(dialog()).toBeNull()
    unmount()
  })

  test('a hook failure has a Hook pill, and no Details when the output is just the summary', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
      f.on('quirky.git/commit', () => {
        throw failure('Pre-commit hook failed.', { reason: 'hook', summary: 'Pre-commit hook failed.', output: 'Pre-commit  hook failed.' })
      })
    })
    await type(message(element), 'Add math')
    await click(primary(element))
    expect(q(element, '.scm-pill')?.textContent).toBe('Hook')
    expect(buttonText(q(element, '.scm-card-blocked')!, 'Details')).toBeUndefined()
    unmount()
  })
})

describe('SC-28: the primary button follows the ladder and is reported', () => {
  const rows: Array<[string, Partial<ReturnType<typeof statusOf>>, string, boolean, string]> = [
    ['ahead and behind', { upstreamStatus: upstream(2, 1) }, 'Sync', true, 'Pull 1, push 2'],
    ['patch-equivalent', { upstreamStatus: upstream(2, 2, true) }, 'Force Push', true, 'Remote only has older copies of local commits. Force push 2 branch commits with lease to update origin/zoe/feat.'],
    ['behind', { upstreamStatus: upstream(0, 1) }, 'Pull', true, 'Pull 1 commit(s)'],
    ['ahead', { upstreamStatus: upstream(2, 0) }, 'Push', true, 'Push 2 commit(s)'],
    ['no upstream', { upstreamStatus: { hasUpstream: false, name: null, sha: null, ahead: 0, behind: 0, behindPatchEquivalent: null } }, 'Publish Branch', true, 'Publish this branch to origin'],
    ['up to date', {}, 'Commit', false, 'Nothing to commit. Branch is up to date.'],
    ['detached', { detached: true, branch: null, upstreamStatus: { hasUpstream: false, name: null, sha: null, ahead: 0, behind: 0, behindPatchEquivalent: null } }, 'Commit', false, 'Check out a branch before publishing commits.']
  ]
  for (const [name, overrides, label, enabled, title] of rows) {
    test(`${name}: ${label}`, async () => {
      const { fake, element, unmount } = await open((f) => {
        f.status = statusOf([], overrides)
      })
      expect(primary(element).textContent).toBe(label)
      expect(primary(element).disabled).toBe(!enabled)
      expect(primary(element).title).toBe(title)
      expect(fake.reports.at(-1).primary).toEqual({ label, enabled, title })
      unmount()
    })
  }

  test('the panel reports its state to ui state', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'unstaged'), entry('README.md', 'staged')], { ahead: 1 })
      f.compare = compareOf({ entries: [{ path: 'util.ts', status: 'added', added: 1, removed: 0, binary: false }] })
    })
    await click(rowOf(element, 'math.ts'), { metaKey: true })
    expect(fake.reports.at(-1)).toEqual({
      worktree: 'feat',
      branch: 'zoe/feat',
      base: 'origin/main',
      ahead: 1,
      behind: 0,
      operation: 'none',
      busy: null,
      capped: false,
      sections: [
        { id: 'unstaged', count: 1 },
        { id: 'staged', count: 1 },
        { id: 'branch', count: 1 }
      ],
      primary: { label: 'Commit', enabled: false, title: 'Enter a commit message to commit' },
      selection: ['math.ts'],
      filter: '',
      viewMode: 'list',
      historyOpen: false
    })
    unmount()
  })
})

describe('SC-29: the chevron menu', () => {
  test('lists every action in order and dims what does not apply', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')], { upstreamStatus: upstream(2, 1) })
    })
    await type(message(element), 'msg')
    await click(chevron(element))
    expect(menuLabels()).toEqual([
      'Commit',
      'Commit & Push',
      'Commit & Sync',
      'Push (2)',
      'Force Push (2)',
      'Pull (1)',
      'Fast-forward (1)',
      'Sync (↓1 ↑2)',
      'Rebase from origin/main',
      'Fetch',
      'Publish Branch'
    ])
    const publish = buttonText(document.body, 'Publish Branch')!
    expect(publish.disabled).toBe(true)
    expect(publish.title).toBe('Branch already has an upstream')
    unmount()
  })

  test('Abort merge asks first with the same text as the CLI, then aborts with yes', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')], { operation: 'merge' })
    })
    // the commit box is hidden during an operation, so the card's Abort is the entry point
    await click(buttonText(element, 'Abort merge'))
    expect(dialog()?.getAttribute('aria-label')).toBe('Abort merge?')
    expect(dialog()?.textContent).toContain('This cancels the merge in progress and can discard conflict resolutions made during this merge.')
    await click(buttonText(dialog()!, 'Abort merge'))
    expect(fake.called('quirky.git/abort').at(-1)?.params).toEqual({ worktree: 'feat', yes: true })
    unmount()
  })

  test('a compound action commits first and runs its remote part only if the commit succeeded', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')], { upstreamStatus: upstream(1, 0) })
    })
    await type(message(element), 'msg')
    await click(chevron(element))
    await click(buttonText(document.body, 'Commit & Push'))
    expect(fake.calls.map((c) => c.method).filter((m) => ['quirky.git/commit', 'quirky.git/push'].includes(m))).toEqual(['quirky.git/commit', 'quirky.git/push'])
    unmount()
  })

  test('a failed commit stops Commit & Sync before the sync', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')], { upstreamStatus: upstream(1, 0) })
      f.on('quirky.git/commit', () => {
        throw failure('nope')
      })
    })
    await type(message(element), 'msg')
    await click(chevron(element))
    await click(buttonText(document.body, 'Commit & Sync'))
    expect(fake.called('quirky.git/sync')).toHaveLength(0)
    unmount()
  })

  test('the chevron stays clickable when the primary is disabled', async () => {
    const { element, unmount } = await open()
    expect(primary(element).disabled).toBe(true)
    await click(chevron(element))
    expect(menuLabels().length).toBeGreaterThan(5)
    unmount()
  })
})

describe('SC-30: a running remote call', () => {
  test('the primary reads "Push in progress…" disabled with a spinner and every menu row is disabled', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([], { busy: 'push', upstreamStatus: upstream(1, 0) })
    })
    expect(primary(element).textContent).toBe('Push')
    expect(primary(element).title).toBe('Push in progress…')
    expect(primary(element).disabled).toBe(true)
    expect(q(primary(element), '.scm-spinner')).not.toBeNull()
    await click(chevron(element))
    const rows = qa(document.body, '[role="menu"] button') as HTMLButtonElement[]
    expect(rows.every((b) => b.disabled)).toBe(true)
    unmount()
  })

  test('a fetch in progress puts the spinner on the chevron', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([], { busy: 'fetch', upstreamStatus: upstream(1, 0) })
    })
    expect(q(primary(element), '.scm-spinner')).toBeNull()
    expect(q(chevron(element), '.scm-spinner')).not.toBeNull()
    unmount()
  })
})
