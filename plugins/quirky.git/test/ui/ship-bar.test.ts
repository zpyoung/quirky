import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, click, compareOf, entry, failure, fakeContext, layoutFor, mountPanel, press, q, qa, rowOf, settle, statusOf, type } = s

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

type Fake = ReturnType<typeof fakeContext>
type Upstream = ReturnType<typeof statusOf>['upstreamStatus']

const up = (ahead = 0, behind = 0): Upstream => ({ hasUpstream: true, name: 'origin/zoe/feat', sha: 'b'.repeat(40), ahead, behind, behindPatchEquivalent: null })
const NO_UPSTREAM: Upstream = { hasUpstream: false, name: null, sha: null, ahead: 0, behind: 0, behindPatchEquivalent: null }
const CARET = 'More commit and remote actions'

const agent = (id: string, label: string) => ({ id, label, installed: true, enabled: true, isDefault: id === 'claude', canGenerate: true })
const AGENTS = { defaultAgent: 'claude', agents: [agent('claude', 'Claude'), agent('codex', 'Codex')] }
const NO_REVIEW = { kind: 'no-review' }
const FOUND = { kind: 'found', review: { number: 12, url: 'https://github.com/o/r/pull/12', state: 'open' } }

async function open(configure: (fake: Fake) => void = () => {}) {
  const fake = fakeContext(layoutFor('feat'))
  configure(fake)
  const mounted = mountPanel(fake)
  await settle()
  return { fake, ...mounted }
}

/** Scripts `stage` as the daemon does: every row it names ends up staged. */
function stagesEverything(fake: Fake): void {
  fake.on('quirky.git/stage', () => {
    fake.status = { ...fake.status, entries: fake.status.entries.map((row) => ({ ...row, area: 'staged' as const })) }
    return { ok: true }
  })
}

/** Scripts a commit that empties the working tree and moves HEAD, as a real one would. */
function commitClears(fake: Fake, upstream: Upstream): void {
  stagesEverything(fake)
  fake.on('quirky.git/commit', () => {
    fake.status = statusOf([], { head: 'c'.repeat(40), upstreamStatus: upstream })
    return { sha: 'c'.repeat(40) }
  })
}

const shipButton = (el: HTMLElement) => q(el, '.ui-split-button__primary') as HTMLButtonElement | null
const bar = (el: HTMLElement) => q(el, '[data-git-ship]')!
const message = (el: HTMLElement) => byLabel(el, 'Commit message') as HTMLTextAreaElement | null
const errorLine = (el: HTMLElement) => q(el, '.ui-inline-error')
const sparkle = (el: HTMLElement) => byLabel(el, 'Generate commit message with AI') as HTMLButtonElement | null
const dialogTitle = () => q(document.body, '[role="dialog"] h2')?.textContent
const menuItems = () => qa(document.body, '[role="menuitem"]') as HTMLButtonElement[]
const menuItem = (label: string) => menuItems().find((item) => q(item, '.qt-menu-label')?.firstChild?.textContent === label) ?? null
const detailOf = (label: string) => q(menuItem(label)!, '.ui-help-text')?.textContent
const openCaret = (el: HTMLElement) => click(byLabel(el, CARET))
const choose = async (el: HTMLElement, label: string) => {
  await openCaret(el)
  await click(menuItem(label))
}
const checkboxes = (el: HTMLElement) => qa(el, 'input.git-row__check') as HTMLInputElement[]
const tick = (el: HTMLElement, path: string) => byLabel(el, `Include ${path} in the commit`) as HTMLInputElement

const three = (f: Fake) => {
  f.status = statusOf([entry('a.ts'), entry('b.ts'), entry('c.ts')])
}

describe('scenario 7: the agent commits without changing content', () => {
  test('marks stay, the uncommitted count drops and the button moves to the next step', async () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts']
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf(files.map((path) => entry(path)), { upstreamStatus: NO_UPSTREAM, upstream: null })
      f.marks = { 'a.ts': 'reviewed', 'b.ts': 'reviewed', 'c.ts': 'reviewed' }
    })
    expect(q(element, '[data-count-line]')?.textContent).toBe('3 of 4 reviewed · 4 uncommitted')
    expect(shipButton(element)?.textContent).toBe('Commit 4 files')

    fake.status = statusOf([], { head: 'c'.repeat(40), upstreamStatus: NO_UPSTREAM, upstream: null })
    fake.compare = compareOf({ entries: files.map((path) => ({ path, status: 'modified', added: 1, removed: 0, binary: false })), added: 4, ahead: 1 })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()

    expect(q(element, '[data-count-line]')?.textContent).toBe('3 of 4 reviewed')
    expect(shipButton(element)?.textContent).toBe('Publish branch')
    expect(message(element)).toBeNull()
    expect(fake.marks).toEqual({ 'a.ts': 'reviewed', 'b.ts': 'reviewed', 'c.ts': 'reviewed' })
    unmount()
  })
})

describe('scenario 20: sending review notes', () => {
  const note = (id: string, line: number) => ({ id, worktreeId: 'feat', path: 'a.ts', startLine: line, line, body: `Note ${id}`, createdAt: 1, updatedAt: null })
  const TARGETS = {
    sessions: [{ session: 's1', agent: 'claude', label: 'Claude', title: 'fix tests', status: 'working', state: 'working', lastActivityAt: Date.now(), sendable: true }],
    agents: [{ id: 'claude', label: 'Claude' }]
  }

  test('"Send 2 notes to agent" sits above the message field and lists the live sessions and new agents', async () => {
    const { fake, element, unmount } = await open((f) => {
      three(f)
      f.noteCounts = { 'a.ts': 2 }
      f.on('quirky.git/notes', () => ({ notes: [note('n1', 1), note('n2', 3)] }))
      f.on('quirky.git/noteTargets', () => TARGETS)
      f.on('quirky.git/sendNotes', () => ({ sent: 2 }))
    })
    expect(q(rowOf(element, 'a.ts')!, '.git-row__notes')?.textContent).toBe('✎2')
    expect(q(element, 'section[aria-label="Notes"]')).toBeNull()
    const send = byLabel(element, 'Send 2 notes to agent')!
    expect(send.textContent).toBe('Send 2 notes to agent ▾')
    expect(send.compareDocumentPosition(message(element)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await click(send)
    const text = q(document.body, '[role="menu"]')!.textContent ?? ''
    expect(text).toContain('Claude')
    expect(text).toContain('New agent')
    await click(menuItem('Claude'))
    expect(fake.called('quirky.git/sendNotes').at(-1)?.params).toEqual({ worktree: 'feat', scope: 'all', session: 's1' })
    unmount()
  })

  test('there is no send button without notes', async () => {
    const { element, unmount } = await open(three)
    expect(q(bar(element), '[aria-label^="Send "]')).toBeNull()
    unmount()
  })
})

describe('scenario 22: the button names the next step', () => {
  const cases: Array<[string, (f: Fake) => void, string]> = [
    ['hand-staged files', (f) => void (f.status = statusOf([entry('a.ts', 'staged'), entry('b.ts', 'staged'), entry('c.ts')])), 'Commit 2 staged files'],
    ['uncommitted files, new ones included', (f) => void (f.status = statusOf([entry('a.ts'), entry('b.ts'), entry('n.ts', 'untracked')])), 'Commit 3 files'],
    ['behind its upstream', (f) => void (f.status = statusOf([], { upstreamStatus: up(0, 2) })), 'Pull 2 commits'],
    ['ahead and behind', (f) => void (f.status = statusOf([], { upstreamStatus: up(1, 2) })), 'Sync'],
    ['no upstream', (f) => void (f.status = statusOf([], { upstreamStatus: NO_UPSTREAM })), 'Publish branch'],
    ['unpushed commits', (f) => void (f.status = statusOf([], { upstreamStatus: up(4, 0) })), 'Push 4 commits'],
    ['pushed with no PR', (f) => f.on('quirky.hosting/forBranch', () => NO_REVIEW), 'Create PR'],
    ['an open PR', (f) => f.on('quirky.hosting/forBranch', () => FOUND), 'View PR #12']
  ]
  for (const [name, configure, label] of cases) {
    test(`${name}: ${label}`, async () => {
      const { element, unmount } = await open((f) => {
        f.compare = compareOf({ entries: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0, binary: false }], added: 1, ahead: 1 })
        configure(f)
      })
      expect(shipButton(element)?.textContent).toBe(label)
      unmount()
    })
  }

  test('while the lookup runs Create PR is disabled with the reason', async () => {
    const lookup = Promise.withResolvers<unknown>()
    const { element, unmount } = await open((f) => {
      f.compare = compareOf({ entries: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0, binary: false }], added: 1, ahead: 1 })
      f.on('quirky.hosting/forBranch', () => lookup.promise)
    })
    expect(shipButton(element)?.textContent).toBe('Create PR')
    expect(shipButton(element)?.disabled).toBe(true)
    expect(shipButton(element)?.title).toBe('checking for a pull request…')
    await act(async () => lookup.resolve(NO_REVIEW))
    await settle()
    expect(shipButton(element)?.disabled).toBe(false)
    unmount()
  })
})

describe('scenario 23: from review to an open PR', () => {
  test('Commit, Publish branch, Create PR, then View PR #12', async () => {
    let lookup: unknown = NO_REVIEW
    const { fake, element, unmount } = await open((f) => {
      f.settings['ai-enabled'] = true
      f.status = statusOf([entry('a.ts')], { upstreamStatus: NO_UPSTREAM, upstream: null })
      f.compare = compareOf({ entries: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0, binary: false }], added: 1, ahead: 1 })
      f.on('quirky.agents/list', () => AGENTS)
      f.on('quirky.hosting/forBranch', () => lookup)
      f.on('quirky.git/generateCommitMessage', () => ({ message: 'Add a', subject: 'Add a', body: '', agent: 'claude' }))
      commitClears(f, NO_UPSTREAM)
      f.on('quirky.git/push', () => {
        f.status = statusOf([], { head: 'c'.repeat(40), upstreamStatus: up(0, 0) })
        return { ok: true }
      })
      f.on('quirky.reviews/createOpen', () => ({ opened: true }))
      f.on('quirky.reviews/openLink', () => ({}))
    })
    expect(shipButton(element)?.textContent).toBe('Commit 1 file')

    await click(sparkle(element))
    expect(message(element)?.value).toBe('Add a')
    await click(shipButton(element))
    expect(fake.called('quirky.git/commit').at(-1)?.params).toEqual({ worktree: 'feat', message: 'Add a' })
    expect(shipButton(element)?.textContent).toBe('Publish branch')

    await click(shipButton(element))
    expect(fake.called('quirky.git/push')).toHaveLength(1)
    await s.waitForState(element, () => shipButton(element)?.textContent === 'Create PR' && !shipButton(element)!.disabled)

    await click(shipButton(element))
    expect(fake.called('quirky.reviews/createOpen').at(-1)?.params).toEqual({ worktree: 'feat' })

    lookup = FOUND
    await act(async () => fake.emit({ type: 'quirky.hosting/reviewCacheChanged', data: { worktreeId: 'feat' } }))
    await settle()
    expect(shipButton(element)?.textContent).toBe('View PR #12')
    await click(shipButton(element))
    expect(fake.called('quirky.reviews/openLink').at(-1)?.params).toEqual({ url: 'https://github.com/o/r/pull/12' })
    expect(fake.toasts).toEqual([])
    unmount()
  })
})

describe('scenario 24: hand-staged files are respected', () => {
  test('the button commits the staged files, the staged rows show the filled dot and the caret offers Commit all', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('a.ts', 'staged'), entry('b.ts', 'staged'), entry('c.ts')])
    })
    expect(shipButton(element)?.textContent).toBe('Commit 2 staged files')
    expect(q(rowOf(element, 'a.ts')!, '.git-row__dirty--staged')).not.toBeNull()
    expect(q(rowOf(element, 'b.ts')!, '.git-row__dirty--staged')).not.toBeNull()
    expect(q(rowOf(element, 'c.ts')!, '.git-row__dirty--staged')).toBeNull()
    expect(q(rowOf(element, 'c.ts')!, '.git-row__dirty')).not.toBeNull()
    await openCaret(element)
    expect(menuItem('Commit all 3 files')?.disabled).toBe(false)

    await click(menuItem('Commit all 3 files'))
    expect(fake.called('quirky.git/commit')).toHaveLength(0)
    expect(message(element)?.matches(':focus')).toBe(true)
    unmount()
  })

  test('Commit all stages scope all and commits, with status read before and after', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('a.ts', 'staged'), entry('b.ts')])
      commitClears(f, up(0, 0))
      f.on('quirky.git/stage', () => {
        f.status = statusOf([entry('a.ts', 'staged'), entry('b.ts', 'staged')])
        return { ok: true }
      })
    })
    await type(message(element)!, 'all of it')
    const before = fake.calls.length
    await choose(element, 'Commit all 3 files'.replace('3', '2'))
    const steps = fake.calls.slice(before).map((c) => c.method).filter((m) => /stage|commit|status/.test(m))
    expect(steps.slice(0, 4)).toEqual(['quirky.git/status', 'quirky.git/stage', 'quirky.git/status', 'quirky.git/commit'])
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', scope: 'all' })
    expect(steps.slice(4).includes('quirky.git/status')).toBe(true)
    unmount()
  })
})

describe('scenario 25: committing only some files', () => {
  test('the caret turns rows into ticked checkboxes, the button counts the ticks and a commit leaves the mode', async () => {
    const { fake, element, unmount } = await open((f) => {
      three(f)
      commitClears(f, up(0, 0))
    })
    expect(checkboxes(element)).toHaveLength(0)
    await choose(element, 'Commit selected files…')
    expect(checkboxes(element)).toHaveLength(3)
    expect(checkboxes(element).every((box) => box.checked)).toBe(true)
    expect(shipButton(element)?.textContent).toBe('Commit 3 of 3 files')

    await click(tick(element, 'b.ts'))
    expect(tick(element, 'b.ts').checked).toBe(false)
    expect(shipButton(element)?.textContent).toBe('Commit 2 of 3 files')

    await type(message(element)!, 'two of three')
    await click(shipButton(element))
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['a.ts', 'c.ts'] })
    expect(fake.called('quirky.git/commit').at(-1)?.params).toEqual({ worktree: 'feat', message: 'two of three' })
    expect(checkboxes(element)).toHaveLength(0)
    unmount()
  })

  test('already staged files that are unticked are unstaged first', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('a.ts', 'staged'), entry('b.ts')])
      commitClears(f, up(0, 0))
    })
    await choose(element, 'Commit selected files…')
    await click(tick(element, 'a.ts'))
    await type(message(element)!, 'just b')
    await click(shipButton(element))
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['b.ts'] })
    expect(fake.called('quirky.git/unstage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['a.ts'] })
    unmount()
  })

  test('Escape leaves the mode without committing', async () => {
    const { fake, element, unmount } = await open(three)
    await choose(element, 'Commit selected files…')
    expect(checkboxes(element)).toHaveLength(3)
    await press(q(element, '[role="listbox"]')!, 'Escape')
    expect(checkboxes(element)).toHaveLength(0)
    expect(shipButton(element)?.textContent).toBe('Commit 3 files')
    expect(fake.called('quirky.git/commit')).toHaveLength(0)
    unmount()
  })

  test('with every file unticked the button cannot commit', async () => {
    const { element, unmount } = await open(three)
    await choose(element, 'Commit selected files…')
    for (const path of ['a.ts', 'b.ts', 'c.ts']) await click(tick(element, path))
    expect(shipButton(element)?.textContent).toBe('Commit 0 of 3 files')
    expect(shipButton(element)?.disabled).toBe(true)
    unmount()
  })
})

describe('scenario 26: committing without a message', () => {
  test('sets the error line, focuses the field and commits nothing', async () => {
    const { fake, element, unmount } = await open(three)
    await click(shipButton(element))
    expect(fake.called('quirky.git/commit')).toHaveLength(0)
    expect(fake.called('quirky.git/stage')).toHaveLength(0)
    expect(errorLine(element)?.textContent).toContain('Write a commit message, or click ✦')
    expect(message(element)?.matches(':focus')).toBe(true)
    expect(fake.toasts).toEqual([])
    unmount()
  })

  test('the line clears when the message is committed on the next attempt', async () => {
    const { element, unmount } = await open((f) => {
      three(f)
      commitClears(f, up(0, 0))
    })
    await click(shipButton(element))
    expect(errorLine(element)).not.toBeNull()
    await type(message(element)!, 'now there is one')
    await click(shipButton(element))
    expect(errorLine(element)).toBeNull()
    unmount()
  })

  test('a whitespace message counts as empty', async () => {
    const { fake, element, unmount } = await open(three)
    await type(message(element)!, '   ')
    await click(shipButton(element))
    expect(fake.called('quirky.git/commit')).toHaveLength(0)
    expect(errorLine(element)).not.toBeNull()
    unmount()
  })
})

describe('scenario 27: generating the message', () => {
  const aiOn = (f: Fake) => {
    f.settings['ai-enabled'] = true
    three(f)
    f.on('quirky.agents/list', () => AGENTS)
    f.on('quirky.git/generateCommitMessage', () => ({ message: 'Rename x', subject: 'Rename x', body: '', agent: 'claude' }))
  }

  test('✦ fills the message with no dialog and the field says who wrote it', async () => {
    const { fake, element, unmount } = await open(aiOn)
    await click(sparkle(element))
    expect(dialogTitle()).toBeUndefined()
    expect(fake.called('quirky.git/generateCommitMessage').map((c) => c.params)).toEqual([{ worktree: 'feat', scope: 'all' }])
    expect(message(element)?.value).toBe('Rename x')
    expect(q(element, '[data-git-written-by]')?.textContent).toBe('Written by Claude')
    unmount()
  })

  test('editing the message clears the line', async () => {
    const { element, unmount } = await open(aiOn)
    await click(sparkle(element))
    await type(message(element)!, 'Rename x to count')
    expect(q(element, '[data-git-written-by]')).toBeNull()
    unmount()
  })

  test('the scope is staged when anything is staged by hand', async () => {
    const { fake, element, unmount } = await open((f) => {
      aiOn(f)
      f.status = statusOf([entry('a.ts', 'staged'), entry('b.ts')])
    })
    await click(sparkle(element))
    expect(fake.called('quirky.git/generateCommitMessage')[0]?.params).toEqual({ worktree: 'feat', scope: 'staged' })
    unmount()
  })

  test('the ✦ menu offers Choose agent…, which opens the dialog and runs once with that choice', async () => {
    const { fake, element, unmount } = await open(aiOn)
    await click(byLabel(element, 'Commit message options'))
    expect(menuItem('Choose agent…')).not.toBeNull()
    await click(menuItem('Choose agent…'))
    expect(dialogTitle()).toBe('Generate Commit Message')
    expect(fake.called('quirky.git/generateCommitMessage')).toHaveLength(0)
    await click(Array.from(qa(document.body, '[role="dialog"] button')).find((b) => b.textContent === 'Generate')!)
    expect(fake.called('quirky.git/generateCommitMessage')[0]?.params).toMatchObject({ worktree: 'feat', scope: 'all', agent: 'claude' })
    expect(message(element)?.value).toBe('Rename x')
    unmount()
  })

  test('a failed generation goes to the error line, not a toast', async () => {
    const { fake, element, unmount } = await open((f) => {
      aiOn(f)
      f.on('quirky.git/generateCommitMessage', () => {
        throw failure('Claude failed: quota exceeded', { reason: 'failed' })
      })
    })
    await click(sparkle(element))
    expect(errorLine(element)?.textContent).toContain('Claude failed: quota exceeded')
    expect(fake.toasts).toEqual([])
    expect(message(element)?.value).toBe('')
    unmount()
  })

  test('there is no ✦ while Source Control AI actions are off', async () => {
    const { element, unmount } = await open(three)
    expect(sparkle(element)).toBeNull()
    expect(byLabel(element, 'Commit message options')).toBeNull()
    unmount()
  })
})

describe('scenario 28: a step that can not run', () => {
  test('with no GitHub remote Create PR is greyed with its reason and no banner says the remote is missing', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: NO_UPSTREAM })
      f.compare = compareOf({ entries: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0, binary: false }], added: 1, ahead: 1 })
    })
    await openCaret(element)
    expect(menuItem('Create PR')?.disabled).toBe(true)
    expect(detailOf('Create PR')).toBe('no GitHub remote')
    expect(detailOf('Pull')).toBe('no upstream yet')
    expect(menuItem('Pull')?.disabled).toBe(true)
    expect(menuItem('Publish branch')?.disabled).toBe(false)
    expect(element.textContent?.toLowerCase()).not.toContain('no github remote')
    unmount()
  })

  test('Fast-forward and Rebase from base are always listed', async () => {
    const { element, unmount } = await open(three)
    await openCaret(element)
    expect(menuItem('Fast-forward')).not.toBeNull()
    expect(menuItem('Rebase from origin/main')).not.toBeNull()
    expect(detailOf('Fast-forward')).toBe('nothing to pull')
    unmount()
  })

  test('with everything pushed and no GitHub remote the bar is a quiet line with the caret beside it', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.compare = compareOf({ entries: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0, binary: false }], added: 1, ahead: 1 })
    })
    expect(shipButton(element)).toBeNull()
    expect(q(element, '[data-git-up-to-date]')?.textContent).toBe('Pushed to origin/zoe/feat')
    expect(message(element)).toBeNull()
    await openCaret(element)
    expect(detailOf('Create PR')).toBe('no GitHub remote')
    await click(menuItem('Fetch'))
    expect(fake.called('quirky.git/fetch')).toHaveLength(1)
    unmount()
  })
})

describe('scenario 29: a step fails', () => {
  const rejected = (f: Fake) => {
    f.status = statusOf([], { upstreamStatus: up(4, 0) })
    f.on('quirky.git/push', () => {
      throw failure('Push rejected: remote has newer commits.', { reason: 'non-fast-forward' })
    })
  }

  test('one line above the button names the failure and offers Pull first, with no toast', async () => {
    const { fake, element, unmount } = await open(rejected)
    expect(shipButton(element)?.textContent).toBe('Push 4 commits')
    await click(shipButton(element))
    const line = errorLine(element)!
    expect(line.textContent).toContain('Push rejected: the remote has new commits')
    expect(q(line, '.ui-inline-error__action')?.textContent).toBe('Pull first')
    expect(line.compareDocumentPosition(shipButton(element)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(qa(element, '.ui-inline-error')).toHaveLength(1)
    expect(fake.toasts).toEqual([])
    expect(fake.called('quirky.git/fetch')).toHaveLength(1)
    unmount()
  })

  test('Pull first runs a pull and the line clears on the next attempt', async () => {
    const { fake, element, unmount } = await open(rejected)
    await click(shipButton(element))
    await click(q(errorLine(element)!, '.ui-inline-error__action'))
    expect(fake.called('quirky.git/pull')).toHaveLength(1)
    expect(errorLine(element)).toBeNull()
    unmount()
  })

  test('the × clears the line', async () => {
    const { element, unmount } = await open(rejected)
    await click(shipButton(element))
    await click(byLabel(errorLine(element)!, 'Dismiss'))
    expect(errorLine(element)).toBeNull()
    unmount()
  })

  test('a second attempt clears the line while it runs', async () => {
    let fail = true
    const second = Promise.withResolvers<{ ok: true }>()
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(4, 0) })
      f.on('quirky.git/push', () => {
        if (fail) throw failure('rejected', { reason: 'non-fast-forward' })
        return second.promise
      })
    })
    await click(shipButton(element))
    expect(errorLine(element)).not.toBeNull()
    fail = false
    await click(shipButton(element))
    expect(errorLine(element)).toBeNull()
    expect(fake.called('quirky.git/push')).toHaveLength(2)
    await act(async () => second.resolve({ ok: true }))
    unmount()
  })

  test('a network failure offers Retry, which repeats the step', async () => {
    let fail = true
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(0, 2) })
      f.on('quirky.git/pull', () => {
        if (fail) throw failure('offline', { reason: 'network' })
        return { ok: true }
      })
    })
    await click(shipButton(element))
    expect(errorLine(element)?.textContent).toContain('Pull failed. offline')
    fail = false
    await click(q(errorLine(element)!, '.ui-inline-error__action'))
    expect(fake.called('quirky.git/pull')).toHaveLength(2)
    expect(errorLine(element)).toBeNull()
    expect(fake.toasts).toEqual([])
    unmount()
  })

  test('a refused commit shows its summary, Details with the output and AI Fix, and no toast', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.settings['ai-enabled'] = true
      three(f)
      stagesEverything(f)
      f.on('quirky.agents/list', () => AGENTS)
      f.on('quirky.git/commit', () => {
        throw failure('Lint failed during commit.', { reason: 'lint', summary: 'Lint failed during commit.', output: 'eslint found 2 problems' })
      })
    })
    await type(message(element)!, 'msg')
    await click(shipButton(element))
    expect(errorLine(element)?.textContent).toContain('Lint failed during commit.')
    expect(fake.toasts).toEqual([])
    expect(byLabel(element, 'Start the default AI agent to fix this commit failure')).not.toBeNull()
    await click(q(errorLine(element)!, '.ui-inline-error__action'))
    expect(dialogTitle()).toBe('Commit Failed')
    expect(q(document.body, '[role="dialog"] pre')?.textContent).toBe('eslint found 2 problems')
    unmount()
  })

  test('a rejected hook on push shows the Push Failed details', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(1, 0) })
      f.on('quirky.git/push', () => {
        throw failure('Pre-push hook failed.', { reason: 'hook', summary: 'Pre-push hook failed.', output: 'husky exited with code 1' })
      })
    })
    await click(shipButton(element))
    expect(errorLine(element)?.textContent).toContain('Pre-push hook failed.')
    await click(q(errorLine(element)!, '.ui-inline-error__action'))
    expect(dialogTitle()).toBe('Push Failed')
    expect(fake.toasts).toEqual([])
    unmount()
  })

  test('Create PR with an unavailable lookup reports the failure in the error line', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.compare = compareOf({ entries: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0, binary: false }], added: 1, ahead: 1 })
      f.on('quirky.hosting/forBranch', () => ({ kind: 'unavailable', message: 'gh is not signed in' }))
    })
    expect(shipButton(element)?.textContent).toBe('Create PR')
    expect(shipButton(element)?.disabled).toBe(false)
    await click(shipButton(element))
    expect(errorLine(element)?.textContent).toContain('gh is not signed in')
    expect(fake.called('quirky.reviews/createOpen')).toHaveLength(0)
    expect(fake.toasts).toEqual([])
    unmount()
  })
})

describe('scenario 30: nothing to review', () => {
  test('the panel shows one quiet line and no ship bar, message field or buttons', async () => {
    const { element, unmount } = await open()
    expect(q(element, '[data-git-clean]')?.textContent).toBe('Nothing changed against origin/main · up to date with origin/zoe/feat')
    expect(q(element, '[data-git-ship-bar]')).toBeNull()
    expect(message(element)).toBeNull()
    expect(shipButton(element)).toBeNull()
    expect(byLabel(element, CARET)).toBeNull()
    unmount()
  })

  test('with no upstream the line leaves the upstream out', async () => {
    const { element, unmount } = await open((f) => void (f.status = statusOf([], { upstreamStatus: NO_UPSTREAM, upstream: null })))
    expect(q(element, '[data-git-clean]')?.textContent).toBe('Nothing changed against origin/main')
    unmount()
  })
})

describe('scenario 31: unpushed commits with nothing to review', () => {
  test('the base branch pushes, and Create PR stays greyed with the reason', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { branch: 'main', upstreamStatus: { ...up(2, 0), name: 'origin/main' } })
      f.compare = compareOf({ base: 'origin/main' })
      f.on('quirky.hosting/forBranch', () => NO_REVIEW)
    })
    expect(shipButton(element)?.textContent).toBe('Push 2 commits')
    await openCaret(element)
    expect(menuItem('Create PR')?.disabled).toBe(true)
    expect(detailOf('Create PR')).toBe('this is the base branch')
    await click(menuItem('Push 2 commits'))
    expect(fake.called('quirky.git/push')).toHaveLength(1)
    unmount()
  })
})

describe('the ship steps run through the caret', () => {
  test('Commit & push commits, then pushes', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('a.ts', 'staged')], { upstreamStatus: up(0, 0) })
      commitClears(f, up(0, 0))
    })
    await type(message(element)!, 'ship it')
    await choose(element, 'Commit & push')
    expect(fake.calls.map((c) => c.method).filter((m) => m === 'quirky.git/commit' || m === 'quirky.git/push')).toEqual(['quirky.git/commit', 'quirky.git/push'])
    unmount()
  })

  test('Commit & push stops at a failed commit', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('a.ts', 'staged')], { upstreamStatus: up(0, 0) })
      f.on('quirky.git/commit', () => {
        throw failure('nope')
      })
    })
    await type(message(element)!, 'ship it')
    await choose(element, 'Commit & push')
    expect(fake.called('quirky.git/push')).toHaveLength(0)
    expect(errorLine(element)?.textContent).toContain('nope')
    unmount()
  })

  test('Pull, Fast-forward and Rebase from base run their calls', async () => {
    const { fake, element, unmount } = await open((f) => void (f.status = statusOf([], { upstreamStatus: up(0, 1) })))
    await choose(element, 'Pull 1 commit')
    await choose(element, 'Fast-forward')
    await choose(element, 'Rebase from origin/main')
    expect(fake.calls.map((c) => c.method).filter((m) => /pull|fastForward|rebaseFromBase/.test(m))).toEqual([
      'quirky.git/pull',
      'quirky.git/fastForward',
      'quirky.git/rebaseFromBase'
    ])
    unmount()
  })

  test('Force push asks first and sends the lease', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(2, 0) })
      f.on('quirky.git/describeForcePush', () => 'Force push zoe/feat to origin? This replaces the remote branch.')
    })
    await choose(element, 'Force push')
    expect(dialogTitle()).toBe('Force push zoe/feat to origin?')
    expect(fake.called('quirky.git/forcePush')).toHaveLength(0)
    await click(Array.from(qa(document.body, '[role="dialog"] button')).find((b) => b.textContent === 'Force Push')!)
    expect(fake.called('quirky.git/forcePush').at(-1)?.params).toEqual({ worktree: 'feat', yes: true, expected: 'b'.repeat(40) })
    unmount()
  })

  test('a diverged branch of rebased copies reads "Force push 2 commits" and asks before sending', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: { ...up(2, 2), behindPatchEquivalent: true } })
      f.on('quirky.git/describeForcePush', () => 'Force push zoe/feat to origin? This replaces the remote branch.')
    })
    expect(shipButton(element)?.textContent).toBe('Force push 2 commits')
    await click(shipButton(element))
    expect(dialogTitle()).toBe('Force push zoe/feat to origin?')
    expect(fake.called('quirky.git/forcePush')).toHaveLength(0)
    unmount()
  })

  test('while a push runs the button is busy and only one push is sent', async () => {
    const pending = Promise.withResolvers<{ ok: true }>()
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { upstreamStatus: up(2, 0) })
      f.on('quirky.git/push', () => pending.promise)
    })
    await click(shipButton(element))
    expect(shipButton(element)?.disabled).toBe(true)
    expect(shipButton(element)?.getAttribute('aria-busy')).toBe('true')
    await click(shipButton(element))
    expect(fake.called('quirky.git/push')).toHaveLength(1)
    await act(async () => pending.resolve({ ok: true }))
    await settle()
    unmount()
  })

  test('Command-Enter in the message field commits', async () => {
    const { fake, element, unmount } = await open((f) => {
      three(f)
      commitClears(f, up(0, 0))
    })
    await type(message(element)!, 'quick')
    await press(message(element)!, 'Enter', { metaKey: true })
    expect(fake.called('quirky.git/commit')).toHaveLength(1)
    unmount()
  })
})

describe('the conflict card takes the ship bar place', () => {
  test('a merge stopped on a conflict shows the card and no ship bar', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('a.ts', 'conflicts', 'modified', { conflict: { kind: 'both_modified', state: 'unresolved' } })], { operation: 'merge' })
    })
    expect(q(element, '[data-git-ship] .ui-inline-agent-card h3')?.textContent).toBe('Merge conflicts: 1 unresolved')
    expect(q(element, '[data-git-ship-bar]')).toBeNull()
    expect(message(element)).toBeNull()
    expect(q(element, '[data-section="conflicts"]')).toBeNull()
    expect(bar(element).textContent).not.toContain('conflict(s)')
    unmount()
  })
})
