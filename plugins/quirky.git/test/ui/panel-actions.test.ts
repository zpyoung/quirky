import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, compareOf, entry, failure, fakeContext, layoutFor, mountPanel, noticeOf, noticesOf, press, q, qa, rowOf, settle, statusOf, type, waitForState } = s

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

const primary = (element: HTMLElement) => q(element, '.ui-split-button__primary') as HTMLButtonElement
const errorLine = (element: HTMLElement) => q(element, '.ui-inline-error')
const shipText = (element: HTMLElement) => primary(element)?.textContent ?? q(element, '[data-git-up-to-date]')?.textContent ?? null
const SOMETHING_TO_SHIP = compareOf({ entries: [{ path: 'util.ts', status: 'modified', added: 1, removed: 0, binary: false }], added: 1, ahead: 1 })
/** Scripts `stage` as the daemon does: every row it names ends up staged. */
const stagesEverything = (fake: Fake) =>
  fake.on('quirky.git/stage', () => {
    fake.status = { ...fake.status, entries: fake.status.entries.map((row) => ({ ...row, area: 'staged' as const })) }
    return { ok: true }
  })
const caretEntries = () => qa(document.body, '[role="menuitem"]') as HTMLButtonElement[]
const caretLabel = (item: Element) => q(item as HTMLElement, '.qt-menu-label')?.firstChild?.textContent ?? ''
const caretEntry = (label: string) => caretEntries().find((item) => caretLabel(item) === label)
const chevron = (element: HTMLElement) => byLabel(element, 'More commit and remote actions') as HTMLButtonElement
const dialog = () => q(document.body, '[role="dialog"]')
const dialogTitle = () => {
  const titleId = dialog()?.getAttribute('aria-labelledby')
  return titleId ? document.getElementById(titleId)?.textContent ?? null : null
}
const message = (element: HTMLElement) => byLabel(element, 'Commit message') as HTMLTextAreaElement
const recoveryTarget = (element: HTMLElement) => q(element, '[data-base-ref]') ?? chevron(element)
const listbox = (element: HTMLElement) => q(element, '[role="listbox"]') as HTMLElement

describe('Source Control focus recovery', () => {
  test('does not move focus on initial panel mount', async () => {
    const before = document.activeElement
    const { unmount } = await open()
    expect(document.activeElement === before).toBe(true)
    unmount()
  })
})


/** Selects a row and presses its inline Revert button. */
async function revert(element: HTMLElement, path: string) {
  await click(rowOf(element, path))
  await click(byLabel(element, `Revert ${path}`))
}

/** Right-clicks a row and picks `label` from its menu. */
async function fromMenu(element: HTMLElement, path: string, label: string) {
  await act(async () => {
    rowOf(element, path)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
  })
  await settle()
  await click(buttonText(document.body, label))
}

describe('SC-23: the Revert file dialogs', () => {
  const rows = (fake: Fake) => {
    fake.status = statusOf([
      entry('math.ts', 'unstaged'),
      entry('gone.ts', 'unstaged', 'deleted'),
      entry('notes.txt', 'untracked'),
      entry('README.md', 'staged')
    ])
  }

  const cases: Array<[string, string, string, string]> = [
    ['math.ts', 'Discard changes to "math.ts"?', 'This will revert the unstaged changes to this file. This cannot be undone.', 'Discard'],
    ['gone.ts', 'Restore "gone.ts"?', 'This will restore the last staged version and discard the deletion. This cannot be undone.', 'Restore'],
    ['notes.txt', 'Delete "notes.txt"?', 'This will permanently delete this file. This cannot be undone.', 'Delete']
  ]
  for (const [path, title, body, confirm] of cases) {
    test(`Revert on ${path} asks "${title}" with the shared dialog focused, then discards with yes`, async () => {
      const { fake, element, unmount } = await open(rows)
      await revert(element, path)
      expect(dialogTitle()).toBe(title)
      expect(dialog()?.textContent).toContain(body)
      const confirmButton = buttonText(dialog()!, confirm)!
      expect(dialog()?.contains(document.activeElement)).toBe(true)
      expect(fake.called('quirky.git/discard')).toHaveLength(0)
      await click(confirmButton)
      expect(fake.called('quirky.git/discard').at(-1)?.params).toEqual({ worktree: 'feat', paths: [path], yes: true })
      unmount()
    })
  }

  test('a staged file is unstaged, then discarded, and the confirm says it reverts the staged changes', async () => {
    const { fake, element, unmount } = await open(rows)
    await revert(element, 'README.md')
    expect(dialogTitle()).toBe('Discard changes to "README.md"?')
    expect(dialog()?.textContent).toContain('This will unstage and revert the changes to this file.')
    await click(buttonText(dialog()!, 'Discard'))
    expect(fake.called('quirky.git/unstage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['README.md'] })
    expect(fake.called('quirky.git/discard').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['README.md'], yes: true })
    unmount()
  })

  test('recovers focus before a delete completes and keeps it through a later row-removing status read', async () => {
    const pendingDiscard = Promise.withResolvers<{ ok: boolean }>()
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('notes.txt', 'untracked')])
      f.on('quirky.git/discard', () => pendingDiscard.promise)
    })
    await click(rowOf(element, 'notes.txt'))
    const opener = byLabel(element, 'Revert notes.txt')!
    const statusReads = fake.called('quirky.git/status').length
    try {
      opener.focus()
      await click(opener)
      await click(buttonText(dialog()!, 'Delete'))
      const target = recoveryTarget(element)
      expect(fake.called('quirky.git/discard')).toHaveLength(1)
      expect(q(element, '[data-row-path="notes.txt"]')).not.toBeNull()
      expect(target?.isConnected).toBe(true)
      expect((target as HTMLButtonElement).disabled).toBe(false)
      expect(document.activeElement === target).toBe(true)
      await act(async () => pendingDiscard.resolve({ ok: true }))
      await settle()
      expect(fake.called('quirky.git/status').length).toBeGreaterThan(statusReads)
      expect(q(element, '[data-row-path="notes.txt"]')).not.toBeNull()
      expect(document.activeElement === target).toBe(true)
      fake.status = statusOf([])
      await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
      await waitForState(element, () => q(element, '[data-row-path="notes.txt"]') === null)
      expect(document.activeElement === target).toBe(true)
    } finally {
      await act(async () => pendingDiscard.resolve({ ok: true }))
      await settle()
      unmount()
    }
  })

  test('Cancel changes nothing and Escape cancels too', async () => {
    const { fake, element, unmount } = await open(rows)
    await revert(element, 'math.ts')
    await click(buttonText(dialog()!, 'Cancel'))
    expect(dialog()).toBeNull()
    await click(byLabel(element, 'Revert math.ts'))
    await press(dialog()!, 'Escape')
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
    await fromMenu(element, 'new.ts', 'Unstage')
    expect(fake.called('quirky.git/unstage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['new.ts', 'old.ts'] })
    unmount()
  })
})

describe('SC-24: stage and revert failures show one notice with Retry', () => {
  test('a row failure shows the notice with Retry, replaced rather than stacked', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'unstaged')])
      f.on('quirky.git/discard', () => {
        throw new Error('EACCES: permission denied')
      })
    })
    await click(rowOf(element, 'math.ts'))
    for (let i = 0; i < 2; i++) {
      await click(byLabel(element, 'Revert math.ts'))
      await click(buttonText(dialog()!, 'Discard'))
    }
    const notices = noticesOf(element)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.textContent).toContain('Failed to revert “math.ts”')
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
      await fromMenu(element, 'math.ts', 'Stage')
      expect(noticeOf(element)?.textContent).toContain('Failed to stage “math.ts”')
      await act(async () => delays.forEach((run) => run()))
      expect(buttonText(noticeOf(element)!, 'Retry')).toBeUndefined()
      expect(byLabel(noticeOf(element)!, 'Dismiss notification')).toBeDefined()
      await click(byLabel(noticeOf(element)!, 'Dismiss notification'))
      expect(noticeOf(element)).toBeNull()
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
    await fromMenu(element, 'math.ts', 'Stage')
    fail = false
    await click(buttonText(noticeOf(element)!, 'Retry'))
    expect(fake.called('quirky.git/stage')).toHaveLength(2)
    expect(noticeOf(element)).toBeNull()
    unmount()
  })

  test('a revert where the file fails shows the first message the daemon gave for it', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('a.ts', 'unstaged')])
      f.on('quirky.git/discard', () => {
        throw failure('Failed to discard 1 file(s)', { failures: [{ path: 'a.ts', message: 'read-only' }] })
      })
    })
    await revert(element, 'a.ts')
    await click(buttonText(dialog()!, 'Discard'))
    const notice = noticeOf(element)!
    expect(notice.textContent).toContain('Failed to revert “a.ts”')
    expect(notice.textContent).toContain('read-only')
    unmount()
  })

  test('a failed mark shows a notice with Retry', async () => {
    let fail = true
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'unstaged')])
      f.on('quirky.git/setReviewMark', (params) => {
        if (fail) throw new Error('database is locked')
        f.marks[params.path as string] = 'reviewed'
        return { mark: 'reviewed' }
      })
    })
    await fromMenu(element, 'math.ts', 'Mark reviewed')
    expect(noticeOf(element)?.textContent).toContain('Failed to mark “math.ts” reviewed')
    fail = false
    await click(buttonText(noticeOf(element)!, 'Retry'))
    expect(fake.called('quirky.git/setReviewMark')).toHaveLength(2)
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
    await fromMenu(element, 'math.ts', 'Stage')
    await act(async () => fake.setLayout(layoutFor('other')))
    await settle()
    const notice = noticeOf(element)!
    expect(notice.textContent).toContain('Failed to stage “math.ts” in feat')
    expect(buttonText(notice, 'Retry')).toBeUndefined()
    unmount()
  })
})

describe('SC-25: the message box and the commit step', () => {
  test('changes with nothing staged read "Commit N files"; an empty message stops the click, a message stages everything and commits', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'unstaged')])
      stagesEverything(f)
    })
    expect(primary(element).textContent).toBe('Commit 1 file')
    expect(primary(element).disabled).toBe(false)
    await click(primary(element))
    expect(errorLine(element)?.textContent).toContain('Write a commit message, or click ✦')
    expect(fake.called('quirky.git/stage')).toHaveLength(0)
    await type(message(element), 'msg')
    await click(primary(element))
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', scope: 'all' })
    expect(fake.called('quirky.git/commit').at(-1)?.params).toEqual({ worktree: 'feat', message: 'msg' })
    unmount()
  })

  test('hand-staged files read "Commit N staged files" and commit without staging', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged'), entry('util.ts', 'unstaged')])
    })
    expect(primary(element).textContent).toBe('Commit 1 staged file')
    await type(message(element), 'msg')
    await click(primary(element))
    expect(fake.called('quirky.git/stage')).toHaveLength(0)
    expect(fake.called('quirky.git/commit')).toHaveLength(1)
    unmount()
  })

  test('Cmd+Enter commits with the trimmed message, clears the box and re-reads status and compare around it', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
    })
    await type(message(element), '  fix the login  ')
    const before = fake.calls.length
    await press(message(element), 'Enter', { metaKey: true })
    expect(fake.calls.slice(before).map((c) => c.method).filter((m) => ['quirky.git/status', 'quirky.git/commit', 'quirky.git/compare'].includes(m))).toEqual([
      'quirky.git/status',
      'quirky.git/commit',
      'quirky.git/status',
      'quirky.git/compare'
    ])
    expect(fake.called('quirky.git/commit').at(-1)?.params).toEqual({ worktree: 'feat', message: 'fix the login' })
    expect(message(element).value).toBe('')
    unmount()
  })

  test('recovers focus while a commit is pending and retains it after completion', async () => {
    const pendingCommit = Promise.withResolvers<{ sha: string }>()
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
      f.on('quirky.git/commit', () => pendingCommit.promise)
    })
    try {
      await type(message(element), 'Add math')
      primary(element).focus()
      await click(primary(element))
      const target = recoveryTarget(element)
      expect(primary(element).disabled).toBe(true)
      expect(target?.isConnected).toBe(true)
      expect((target as HTMLButtonElement).disabled).toBe(false)
      expect(document.activeElement === target).toBe(true)
      await act(async () => pendingCommit.resolve({ sha: 'd'.repeat(40) }))
      await settle()
      expect(document.activeElement === target).toBe(true)
    } finally {
      await act(async () => pendingCommit.resolve({ sha: 'd'.repeat(40) }))
      await settle()
      unmount()
    }
  })

  test('does not steal focus from another enabled control when a commit fails', async () => {
    const pendingCommit = Promise.withResolvers<{ sha: string }>()
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
      f.on('quirky.git/commit', () => pendingCommit.promise)
    })
    try {
      await type(message(element), 'Add math')
      primary(element).focus()
      await click(primary(element))
      const chosen = listbox(element)
      chosen.focus()
      await act(async () => pendingCommit.reject(new Error('fatal: nope')))
      await settle()
      expect(errorLine(element)?.textContent).toContain('fatal: nope')
      expect(fake.toasts).toEqual([])
      expect(document.activeElement === chosen).toBe(true)
    } finally {
      await act(async () => pendingCommit.resolve({ sha: 'd'.repeat(40) }))
      await settle()
      unmount()
    }
  })

  test('does not steal focus if a user moves outside the panel during a pending commit', async () => {
    const pendingCommit = Promise.withResolvers<{ sha: string }>()
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
      f.on('quirky.git/commit', () => pendingCommit.promise)
    })
    const outside = document.createElement('button')
    try {
      outside.textContent = 'Other control'
      document.body.appendChild(outside)
      await type(message(element), 'Add math')
      primary(element).focus()
      await click(primary(element))
      outside.focus()
      await act(async () => pendingCommit.resolve({ sha: 'd'.repeat(40) }))
      await settle()
      expect(document.activeElement === outside).toBe(true)
    } finally {
      await act(async () => pendingCommit.resolve({ sha: 'd'.repeat(40) }))
      await settle()
      outside.remove()
      unmount()
    }
  })

  test('Cmd+Enter does nothing when the ship button is not a commit', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: upstream(1, 0) })
    })
    expect(primary(element).textContent).toBe('Push 1 commit')
    await press(element.querySelector('[data-git-panel]')!, 'Enter', { metaKey: true })
    expect(fake.called('quirky.git/commit')).toHaveLength(0)
    expect(fake.called('quirky.git/push')).toHaveLength(0)
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

  test('the box keeps a draft per worktree and goes away when nothing is left to commit', async () => {
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
    fake.status = statusOf([], { upstreamStatus: upstream(1, 0) })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    expect(message(element)).toBeNull()
    unmount()
  })

  test('a classified commit failure keeps its summary and draft without redundant Details', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
      f.on('quirky.git/commit', () => {
        throw failure('fatal: nope', { reason: 'failed' })
      })
    })
    await type(message(element), 'msg')
    await click(primary(element))
    const line = errorLine(element)
    expect(line).not.toBeNull()
    expect(line?.textContent).toContain('fatal: nope')
    expect(buttonText(line as HTMLElement, 'Details')).toBeUndefined()
    expect(fake.toasts).toEqual([])
    expect(message(element).value).toBe('msg')
    unmount()
  })
})

describe('SC-27: a failing hook blocks the commit', () => {
  test('shows the summary in the error line and Details with the raw output', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
      f.on('quirky.git/commit', () => {
        throw failure('Lint failed during commit.', { reason: 'lint', summary: 'Lint failed during commit.', output: 'eslint found 2 problems' })
      })
    })
    await type(message(element), 'Add math')
    await click(primary(element))
    const line = errorLine(element) as HTMLElement
    expect(line.textContent).toContain('Lint failed during commit.')
    expect(fake.toasts).toEqual([])
    await click(buttonText(line, 'Details'))
    expect(dialogTitle()).toBe('Commit Failed')
    expect(q(dialog()!, 'pre')?.textContent).toBe('eslint found 2 problems')
    await click(buttonText(dialog()!, 'Close'))
    expect(dialog()).toBeNull()
    unmount()
  })

  test('a failed commit keeps all output reachable without a toast', async () => {
    const summary = 'Type check found problems'
    const output = [summary, ...Array.from({ length: 30 }, (_, i) => `detail ${i + 1} src/fmt.ts`)].join('\n')
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
      f.on('quirky.git/commit', () => {
        throw failure(summary, { reason: 'failed', summary, output })
      })
    })
    try {
      await type(message(element), 'Add math')
      await click(primary(element))
      const line = errorLine(element) as HTMLElement
      expect(line).not.toBeNull()
      expect(line.textContent).toContain(summary)
      expect(fake.toasts).toEqual([])
      expect(message(element).value).toBe('Add math')
      await click(buttonText(line, 'Details'))
      expect(q(dialog()!, 'pre')?.textContent).toBe(output)
      await click(buttonText(dialog()!, 'Close'))
      await click(buttonText(errorLine(element) as HTMLElement, 'Details'))
      expect(q(dialog()!, 'pre')?.textContent).toBe(output)
    } finally {
      unmount()
    }
  })

  test('a successful commit clears earlier hook and failed errors', async () => {
    for (const reason of ['hook', 'failed'] as const) {
      let fail = true
      const summary = reason === 'hook' ? 'Pre-commit hook failed.' : 'Type check found problems'
      const { element, unmount } = await open((f) => {
        f.status = statusOf([entry('math.ts', 'staged')])
        f.on('quirky.git/commit', () => {
          if (fail) throw failure(summary, { reason, summary, output: `${reason} output` })
          return { sha: 'd'.repeat(40) }
        })
      })
      await type(message(element), 'Add math')
      await click(primary(element))
      expect(errorLine(element) !== null).toBe(true)
      fail = false
      await click(primary(element))
      expect(errorLine(element) !== null).toBe(false)
      unmount()
    }
  })

  test('a hook failure has no Details when the output is just the summary', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
      f.on('quirky.git/commit', () => {
        throw failure('Pre-commit hook failed.', { reason: 'hook', summary: 'Pre-commit hook failed.', output: 'Pre-commit  hook failed.' })
      })
    })
    await type(message(element), 'Add math')
    await click(primary(element))
    expect(errorLine(element)?.textContent).toContain('Pre-commit hook failed.')
    expect(buttonText(errorLine(element) as HTMLElement, 'Details')).toBeUndefined()
    unmount()
  })
})

describe('SC-28: the ship button names the next step and the panel reports it', () => {
  const noUpstream = { hasUpstream: false, name: null, sha: null, ahead: 0, behind: 0, behindPatchEquivalent: null }
  const rows: Array<[string, Partial<ReturnType<typeof statusOf>>, string, boolean, string]> = [
    ['ahead and behind', { upstreamStatus: upstream(2, 1) }, 'Sync', true, ''],
    ['patch-equivalent', { upstreamStatus: upstream(2, 2, true) }, 'Force push 2 commits', true, ''],
    ['behind', { upstreamStatus: upstream(0, 1) }, 'Pull 1 commit', true, ''],
    ['ahead', { upstreamStatus: upstream(2, 0) }, 'Push 2 commits', true, ''],
    ['no upstream', { upstreamStatus: noUpstream }, 'Publish branch', true, ''],
    ['pushed with no GitHub remote', {}, 'Pushed to origin/zoe/feat', false, 'no GitHub remote'],
    ['detached', { detached: true, branch: null, upstreamStatus: noUpstream }, 'Publish branch', false, 'check out a branch first']
  ]
  for (const [name, overrides, label, enabled, reason] of rows) {
    test(`${name}: ${label}`, async () => {
      const { fake, element, unmount } = await open((f) => {
        f.status = statusOf([], overrides)
        f.compare = SOMETHING_TO_SHIP
      })
      expect(shipText(element)).toBe(label)
      expect(primary(element)?.disabled ?? true).toBe(!enabled)
      expect(fake.reports.at(-1).primary).toEqual({ label, enabled, title: reason })
      unmount()
    })
  }

  test('a worktree that matches its base reports no ship step', async () => {
    const { fake, element, unmount } = await open()
    expect(shipText(element)).toBeNull()
    expect(fake.reports.at(-1).primary).toBeNull()
    unmount()
  })

  test('the panel reports its state to ui state', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'unstaged'), entry('README.md', 'staged')], { ahead: 1 })
      f.compare = compareOf({ entries: [{ path: 'util.ts', status: 'added', added: 1, removed: 0, binary: false }] })
    })
    await click(rowOf(element, 'math.ts'))
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
      primary: { label: 'Commit 1 staged file', enabled: true, title: '' },
      selection: ['math.ts'],
      filter: '',
      viewMode: 'list',
      historyOpen: false
    })
    unmount()
  })
})

describe('SC-29: the caret', () => {
  test('lists every step in order and greys what does not apply, with the reason', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')], { upstreamStatus: upstream(2, 1) })
    })
    await click(chevron(element))
    expect(caretEntries().map(caretLabel)).toEqual([
      'Commit all 1 file',
      'Commit selected files…',
      'Commit & push',
      'Commit, push & create PR',
      'Pull 1 commit',
      'Fast-forward',
      'Sync',
      'Push 2 commits',
      'Publish branch',
      'Force push',
      'Rebase from origin/main',
      'Fetch',
      'Create PR',
      'View PR'
    ])
    const publish = caretEntry('Publish branch')!
    expect(publish.disabled).toBe(true)
    expect(q(publish, '.ui-help-text')?.textContent).toBe('already published')
    expect(q(caretEntry('Fast-forward')!, '.ui-help-text')?.textContent).toBe('has local commits')
    expect(caretEntry('Pull 1 commit')!.disabled).toBe(false)
    unmount()
  })

  test('Abort merge asks first with the same text as the CLI, then aborts with yes', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')], { operation: 'merge' })
    })
    // the ship bar is hidden during an operation, so the card's Abort is the entry point
    await click(buttonText(element, 'Abort merge'))
    expect(dialogTitle()).toBe('Abort merge?')
    expect(dialog()?.textContent).toContain('This cancels the merge in progress and can discard conflict resolutions made during this merge.')
    await click(buttonText(dialog()!, 'Abort merge'))
    expect(fake.called('quirky.git/abort').at(-1)?.params).toEqual({ worktree: 'feat', yes: true })
    unmount()
  })

  test('a compound step commits first and runs its remote part only if the commit succeeded', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')], { upstreamStatus: upstream(1, 0) })
    })
    await type(message(element), 'msg')
    await click(chevron(element))
    await click(caretEntry('Commit & push'))
    expect(fake.calls.map((c) => c.method).filter((m) => ['quirky.git/commit', 'quirky.git/push'].includes(m))).toEqual(['quirky.git/commit', 'quirky.git/push'])
    unmount()
  })

  test('a failed commit stops Commit & push before the push', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')], { upstreamStatus: upstream(1, 0) })
      f.on('quirky.git/commit', () => {
        throw failure('nope')
      })
    })
    await type(message(element), 'msg')
    await click(chevron(element))
    await click(caretEntry('Commit & push'))
    expect(fake.called('quirky.git/push')).toHaveLength(0)
    expect(errorLine(element)?.textContent).toContain('nope')
    unmount()
  })

  test('the caret stays clickable when the ship button is disabled', async () => {
    const lookup = Promise.withResolvers<unknown>()
    const { element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: upstream(1, 0) })
      f.on('quirky.hosting/forBranch', () => lookup.promise)
    })
    expect(primary(element).disabled).toBe(true)
    expect(chevron(element).disabled).toBe(false)
    await click(chevron(element))
    expect(caretEntries().length).toBeGreaterThan(5)
    await act(async () => lookup.resolve({ kind: 'no-review' }))
    unmount()
  })
})

describe('C6: linked review push targets', () => {
  const review = {
    kind: 'found',
    review: { number: 7, url: 'https://github.com/upstream/project/pull/7', state: 'open' }
  }
  const target = {
    ready: true,
    remote: 'fork',
    branch: 'zoe/feat',
    localBranch: 'zoe/feat',
    localHead: 'a'.repeat(40),
    headOid: 'c'.repeat(40),
    number: 7,
    fork: true,
    repository: { host: 'github.com', owner: 'fork', repo: 'project' }
  }

  test('shows the exact fork destination and sends linked Push as purpose review', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: upstream(2, 0) })
      f.on('quirky.hosting/forBranch', () => review)
      f.on('quirky.git/pushTarget', () => target)
    })
    await waitForState(element, () => q(element, '[data-git-push-target]') !== null)
    expect(q(element, '[data-git-push-target]')?.textContent).toContain('fork/zoe/feat')
    expect(q(element, '[data-git-push-target]')?.textContent).toContain('Fork')
    expect(fake.called('quirky.git/pushTarget').at(-1)?.params).toEqual({ worktree: 'feat', purpose: 'review' })

    expect(primary(element).textContent).toBe('Push 2 commits')
    await click(primary(element))
    expect(fake.called('quirky.git/push').at(-1)?.params).toEqual({ worktree: 'feat', purpose: 'review' })
    unmount()
  })

  test('force confirmation shows the target and leases the freshly resolved PR head', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: upstream(2, 2, true) })
      f.on('quirky.hosting/forBranch', () => review)
      f.on('quirky.git/pushTarget', () => target)
      f.on('quirky.git/describeForcePush', () => 'Force push zoe/feat to fork?')
    })
    expect(primary(element).textContent).toBe('Force push 2 commits')
    await click(primary(element))
    expect(dialog()?.textContent).toContain('fork/zoe/feat')
    await click(buttonText(dialog()!, 'Force Push'))

    expect(fake.called('quirky.git/forcePush').at(-1)?.params).toMatchObject({
      worktree: 'feat',
      purpose: 'review',
      expected: 'c'.repeat(40),
      yes: true
    })
    unmount()
  })
})

describe('SC-30: a running remote call', () => {
  test('a running push busies the ship button and shuts the caret', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([], { busy: 'push', upstreamStatus: upstream(1, 0) })
    })
    expect(primary(element).disabled).toBe(true)
    expect(primary(element).getAttribute('aria-busy')).toBe('true')
    expect(chevron(element).disabled).toBe(true)
    expect(caretEntries()).toHaveLength(0)
    unmount()
  })
})
