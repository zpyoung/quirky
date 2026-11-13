import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { ChecksPanel } from '../src/checks/ChecksPanel'
import { CreateReview } from '../src/create/CreateReview'
import { Comments } from '../src/detail/Comments'
import { FilesChanged } from '../src/detail/FilesChanged'
import { ReviewPage } from '../src/detail/ReviewPage'
import type { ReviewData, ReviewsState } from '../src/contracts'
import { nextDraftTick } from '../src/draft-field'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DEFAULTS = { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false }
const HOST = 'github.com'
const WORKTREE_A = '/work/a'
const WORKTREE_B = '/work/b'
const roots: Root[] = []

type Call = { method: string; params: Record<string, unknown> }
type RenderProps = { context: UiPluginContext; state: ReviewsState; refresh(): Promise<void>; snapshot?: number }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
type Mounted = {
  element: HTMLElement
  calls: Call[]
  refreshedWorktrees: Array<string | null>
  render(state: ReviewsState, snapshot?: number): void
  unmount(): void
  holdNext(method: string): Deferred<unknown>
  replyNext(method: string, value: unknown): void
}

type StateOptions = {
  worktree?: string
  number?: number
  repoOwner?: string
  repoName?: string
  generation?: number
  commentDraft?: string
  bodyDraft?: string | null
  body?: string
  titleDraft?: string | null
  fileFilter?: string
  diffMode?: 'inline' | 'side-by-side'
  selectedFile?: string | null
  collapsedFiles?: string[]
  treeVisible?: boolean
  creationWorktree?: string | null
  creationGeneration?: number
  title?: string
  createBody?: string
  base?: string
  createDraft?: boolean
  useTemplate?: boolean
  bases?: string[]
  eligibility?: Record<string, unknown> | null
  generating?: boolean
  submitting?: boolean
  result?: Record<string, unknown> | null
}

function stateFor(options: StateOptions = {}): ReviewsState {
  const worktree = options.worktree ?? WORKTREE_A
  const number = options.number ?? 12
  const repoOwner = options.repoOwner ?? 'test-owner'
  const repoName = options.repoName ?? 'test-repo'
  const generation = options.generation ?? 1
  const review: ReviewData = {
    provider: 'github', number, url: `https://${HOST}/${repoOwner}/${repoName}/pull/${number}`,
    title: `Review ${number}`, body: options.body ?? 'old body', state: 'open',
    headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
    mergeable: 'MERGEABLE', checksStatus: 'passing', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
    autoMergeRequest: null, stack: null, mergeMethods: null,
    prRepo: { host: HOST, owner: repoOwner, repo: repoName }
  }
  const prRepo = { host: HOST, owner: repoOwner, repo: repoName }
  const checks = { number, headSha: review.headRefOid, rollup: 'success', checks: [], partial: false, partialFailures: [] }
  const files = {
    number,
    files: [
      { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: null, isBinary: false, patchUnavailable: true, viewed: false, coordinates: [] },
      { path: 'docs/b.md', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: null, isBinary: false, patchUnavailable: true, viewed: false, coordinates: [] }
    ],
    truncated: false, filesUnavailable: false, partialFailures: []
  }
  return {
    revision: 1,
    previousView: null,
    detail: {
      target: { worktree, number, prRepo }, tab: 'conversation', generation, loading: false, error: null, review,
      details: { item: { viewerCanUpdate: true } }, checks,
      comments: { number, comments: [], partial: false, partialFailures: [] }, files,
      audience: 'all', grouping: 'grouped', expandedChecks: [], queuedComments: [], checksCollapsed: false,
      selectedFile: options.selectedFile ?? null, diffMode: options.diffMode ?? 'inline',
      collapsedFiles: options.collapsedFiles ?? [], fileFilter: options.fileFilter ?? '', fileTreeVisible: options.treeVisible ?? true,
      commentDraft: options.commentDraft ?? '', bodyDraft: options.bodyDraft ?? null, pending: [], fetchedAt: Date.now()
    },
    checks: {
      worktree, generation, loading: false, error: null, lookup: null, eligibility: null, review,
      checks, comments: { number, comments: [], partial: false, partialFailures: [] }, conflicts: null,
      audience: 'all', grouping: 'grouped', expandedChecks: [], queuedComments: [], checksCollapsed: false,
      commentDraft: '', titleDraft: options.titleDraft ?? null, height: 320, fetchedAt: Date.now(), agentDialog: null
    },
    creation: {
      worktree: options.creationWorktree === undefined ? worktree : options.creationWorktree,
      generation: options.creationGeneration ?? generation, loading: false, error: null,
      eligibility: options.eligibility === undefined ? { eligible: true, confirmedAt: Date.now() } : options.eligibility,
      title: options.title ?? 'Create title', body: options.createBody ?? 'Create body', base: options.base ?? 'main', head: 'feature',
      draft: options.createDraft ?? false, useTemplate: options.useTemplate ?? false,
      bases: options.bases ?? ['main', 'release'], generating: options.generating ?? false,
      requestId: options.generating ? 'request-a' : null, submitting: options.submitting ?? false, generated: false,
      result: options.result ?? null, defaults: DEFAULTS
    },
    settings: { worktree, generation: 1, loading: false, error: null, diagnostics: null, accounts: null, configuration: null, budget: null, fetchedAt: 0 },
    defaults: DEFAULTS, repoDefaults: {}, botOverrides: [], links: {}, suppressed: {}
  } as unknown as ReviewsState
}

function deferred<T = unknown>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function defaultReply(method: string, params: Record<string, unknown>): unknown {
  if (method === 'quirky.reviews/detailSetCommentDraft' || method === 'quirky.reviews/detailSetBodyDraft') return { applied: true }
  if (method === 'quirky.reviews/detailSetFilesView') return { fileFilter: params.fileFilter, diffMode: params.diffMode }
  if (method === 'quirky.reviews/checksSetTitleDraft') return { titleDraft: params.title }
  if (method === 'quirky.reviews/checksCancelTitle') return { titleDraft: null }
  if (method === 'quirky.reviews/checksSaveTitle') return { updated: true }
  if (method === 'quirky.reviews/createGenerate') return { title: 'A generated', body: 'A body' }
  if (method === 'quirky.reviews/createBase') return { base: params.base }
  if (method === 'quirky.reviews/createDraft') return { updated: true }
  if (method === 'quirky.tasks/state') return { workspaces: [] }
  return {}
}

function mount(renderNode: (props: RenderProps) => ReactNode, initialState = stateFor()): Mounted {
  const calls: Call[] = []
  const refreshedWorktrees: Array<string | null> = []
  const held = new Map<string, Deferred<unknown>[]>()
  const replies = new Map<string, unknown[]>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  let state = initialState
  let layout = {
    view: { id: 'view:quirky.reviews/review' }, worktree: state.checks.worktree,
    panel: null, sidebar: true, focus: 'view', tools: { open: {} }
  } as unknown as UiLayout
  const context = {
    pluginId: 'quirky.reviews',
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      const queue = held.get(method)
      const request = queue?.shift()
      if (queue?.length === 0) held.delete(method)
      if (request) return request.promise
      const responses = replies.get(method)
      if (responses?.length) return responses.shift()
      return defaultReply(method, params)
    },
    getLayout: () => layout,
    onLayout(listener: (next: UiLayout) => void) { layoutListeners.add(listener); return () => layoutListeners.delete(listener) },
    onConnection: () => () => {},
    subscribe: () => () => {},
    getSetting: () => undefined,
    toast() {},
    confirm: async () => false,
    log() {}
  } as unknown as UiPluginContext
  const refresh = async () => {
    const worktree = state.creation.worktree ?? state.detail.target?.worktree ?? state.checks.worktree
    refreshedWorktrees.push(worktree)
    await context.call('quirky.reviews/state', worktree ? { worktree } : {})
  }
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  roots.push(root)
  let snapshot: number | undefined = 0
  const draw = () => root.render(renderNode({ context, state, refresh, snapshot }))
  act(draw)
  return {
    element, calls, refreshedWorktrees,
    unmount() {
      roots.splice(roots.indexOf(root), 1)
      act(() => root.unmount())
    },
    render(next, nextSnapshot = 0) {
      state = next
      snapshot = nextSnapshot
      if (next.checks.worktree !== layout.worktree) {
        layout = { ...layout, worktree: next.checks.worktree } as UiLayout
        for (const listener of [...layoutListeners]) listener(layout)
      }
      act(draw)
    },
    holdNext(method) {
      const request = deferred<unknown>()
      held.set(method, [...(held.get(method) ?? []), request])
      return request
    },
    replyNext(method, value) { replies.set(method, [...(replies.get(method) ?? []), value]) }
  }
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => {})
}

async function click(node: HTMLButtonElement) {
  await act(async () => { node.click() })
}

function reactProps(node: HTMLElement): Record<string, (...args: never[]) => void> {
  const key = Object.getOwnPropertyNames(node).find((candidate) => candidate.startsWith('__reactProps$'))
  if (!key) throw new Error('Could not find React event handlers on the rendered control.')
  return (node as unknown as Record<string, Record<string, (...args: never[]) => void>>)[key]!
}

function changeValue(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  node.value = value
  if (node instanceof HTMLSelectElement) {
    act(() => { node.dispatchEvent(new Event('change', { bubbles: true })) })
    return
  }
  const onChange = reactProps(node).onChange
  if (!onChange) throw new Error('The rendered field does not have an onChange handler.')
  act(() => onChange({ target: node, currentTarget: node } as never))
}

function changeChecked(node: HTMLInputElement, checked: boolean) {
  node.checked = checked
  const onChange = reactProps(node).onChange
  if (!onChange) throw new Error('The rendered checkbox does not have an onChange handler.')
  act(() => onChange({ target: node, currentTarget: node } as never))
}

function blur(node: HTMLElement) {
  const onBlur = reactProps(node).onBlur
  if (!onBlur) throw new Error('The rendered field does not have an onBlur handler.')
  act(() => onBlur({ target: node, currentTarget: node } as never))
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((candidate) =>
    candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label)
  if (!found) throw new Error(`Could not find the ${label} button.`)
  return found
}

function labelledInput(root: ParentNode, label: string): HTMLInputElement {
  const found = [...root.querySelectorAll('input')].find((candidate) =>
    candidate.getAttribute('aria-label') === label || candidate.labels?.[0]?.textContent?.trim() === label)
  if (!found) throw new Error(`Could not find the ${label} input.`)
  return found
}
function labelledSelect(root: ParentNode, label: string): HTMLSelectElement {
  const labelled = [...root.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim() === label)
  const id = labelled?.htmlFor
  const found = id ? root.querySelector<HTMLSelectElement>(`#${id}`) : null
  if (!found) throw new Error(`Could not find the ${label} select.`)
  return found
}

function callsFor(ui: Mounted, method: string): Call[] {
  return ui.calls.filter((call) => call.method === `quirky.reviews/${method}`)
}

function paramsWith(call: Call, values: Record<string, unknown>) {
  expect(call.params).toMatchObject(values)
}

const commentComposer = (root: ParentNode) => root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')!
const titleInput = (root: ParentNode) => root.querySelector<HTMLInputElement>('input[aria-label="Pull request title"]')!
const bodyInput = (root: ParentNode) => root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Pull request description"]')!
const fileFilter = (root: ParentNode) => labelledInput(root, 'Filter files')
const callCount = (ui: Mounted, method: string) => callsFor(ui, method).length


test('C1: a late comment snapshot cannot replace newer composer text', async () => {
  const ui = mount((props) => <Comments {...props} surface="detail" />)
  const write = ui.holdNext('quirky.reviews/detailSetCommentDraft')
  changeValue(commentComposer(ui.element), 'a')
  changeValue(commentComposer(ui.element), 'ab')
  ui.render(stateFor({ commentDraft: 'a' }), 0)
  expect(commentComposer(ui.element).value).toBe('ab')
  await act(async () => write.resolve({ applied: true }))
})

test('C2: a late body snapshot cannot replace newer description text', async () => {
  const ui = mount((props) => <ReviewPage {...props} />)
  await click(button(ui.element, 'Edit description'))
  const editor = bodyInput(ui.element)
  changeValue(editor, 'old body 1')
  changeValue(editor, 'old body 12')
  ui.render(stateFor({ bodyDraft: 'old body 1' }), 0)
  expect(bodyInput(ui.element).value).toBe('old body 12')
})

test('C3: a late Checks title snapshot cannot replace newer title text', async () => {
  const ui = mount((props) => <ChecksPanel {...props} />)
  await click(button(ui.element, 'Edit pull request title'))
  paramsWith(callsFor(ui, 'checksSetTitleDraft')[0]!, { worktree: WORKTREE_A, number: 12, generation: 1, prRepo: { host: HOST, owner: 'test-owner', repo: 'test-repo' } })
  changeValue(titleInput(ui.element), 'Review 12a')
  changeValue(titleInput(ui.element), 'Review 12ab')
  ui.render(stateFor({ titleDraft: 'Review 12a' }), 0)
  expect(titleInput(ui.element).value).toBe('Review 12ab')
})

test('C4: the files view writes one complete latest value through a single lane', async () => {
  const ui = mount((props) => <FilesChanged {...props} />)
  const firstWrite = ui.holdNext('quirky.reviews/detailSetFilesView')
  changeValue(fileFilter(ui.element), 'src')
  expect(ui.element.textContent).toContain('src/a.ts')
  expect(ui.element.textContent).not.toContain('docs/b.md')
  expect(callsFor(ui, 'detailSetFilesView')).toHaveLength(1)
  paramsWith(callsFor(ui, 'detailSetFilesView')[0]!, { fileFilter: 'src', diffMode: 'inline', selectedFile: null, collapsedFiles: [], treeVisible: true, generation: 1 })
  const mode = labelledSelect(ui.element, 'Diff mode')
  changeValue(mode, 'side-by-side')
  changeValue(fileFilter(ui.element), 'src/a')
  expect(callsFor(ui, 'detailSetFilesView')).toHaveLength(1)
  await act(async () => firstWrite.resolve({ fileFilter: 'src', diffMode: 'inline' }))
  await settle()
  expect(callsFor(ui, 'detailSetFilesView')).toHaveLength(2)
  paramsWith(callsFor(ui, 'detailSetFilesView')[1]!, { fileFilter: 'src/a', diffMode: 'side-by-side', selectedFile: null, collapsedFiles: [], treeVisible: true, generation: 1 })
  expect(fileFilter(ui.element).value).toBe('src/a')
  expect(mode.value).toBe('side-by-side')
  ui.render(stateFor({ fileFilter: 'src', diffMode: 'inline' }), 0)
  expect(fileFilter(ui.element).value).toBe('src/a')
  expect(ui.element.querySelector<HTMLSelectElement>('#review-diff-mode')!.value).toBe('side-by-side')
})

test('C5: an unrelated create state echo leaves a held base edit in the field', () => {
  const ui = mount((props) => <CreateReview {...props} />)
  const base = ui.element.querySelector<HTMLInputElement>('#review-base')!
  changeValue(base, 'rel')
  ui.render(stateFor({ title: 'x' }), 0)
  expect(ui.element.querySelector<HTMLInputElement>('#review-base')!.value).toBe('rel')
})

test('C6 and C23: a held base save keeps newer text and sends its generation fence', async () => {
  const ui = mount((props) => <CreateReview {...props} />)
  const write = ui.holdNext('quirky.reviews/createBase')
  const base = ui.element.querySelector<HTMLInputElement>('#review-base')!
  changeValue(base, 'release')
  blur(base)
  await settle()
  paramsWith(callsFor(ui, 'createBase')[0]!, { worktree: WORKTREE_A, base: 'release', generation: 1 })
  changeValue(base, 'rel-next')
  ui.render(stateFor({ base: 'release' }), 0)
  expect(ui.element.querySelector<HTMLInputElement>('#review-base')!.value).toBe('rel-next')
  await act(async () => write.resolve({ base: 'release' }))
  await settle()
  expect(callsFor(ui, 'createBase')).toHaveLength(1)
  expect(ui.element.querySelector<HTMLInputElement>('#review-base')!.value).toBe('rel-next')
  expect(button(ui.element, 'Create PR').disabled).toBe(true)
  expect(ui.element.textContent).toContain('Choose a base branch from the remote refs.')
})

test('C7: a failed base save stays visible and later state cannot replace its value', async () => {
  const ui = mount((props) => <CreateReview {...props} />)
  const write = ui.holdNext('quirky.reviews/createBase')
  const base = ui.element.querySelector<HTMLInputElement>('#review-base')!
  changeValue(base, 'release')
  blur(base)
  await act(async () => write.reject(new Error('Base branch must differ from the head branch.')))
  await settle()
  ui.render(stateFor({ base: 'main' }), nextDraftTick())
  expect(ui.element.querySelector<HTMLInputElement>('#review-base')!.value).toBe('release')
  expect(ui.element.querySelector('[role="alert"]')?.textContent).toContain('Base branch must differ from the head branch.')
})

for (const [label, selector, key] of [
  ['draft option', '#review-create-draft', 'draft'],
  ['template option', '#review-use-template', 'useTemplate']
] as const) {
  test(`C8: a failed ${label} write stays checked across unrelated state replies`, async () => {
    const ui = mount((props) => <CreateReview {...props} />)
    const write = ui.holdNext('quirky.reviews/createDraft')
    const checkbox = ui.element.querySelector<HTMLInputElement>(selector)!
    changeChecked(checkbox, true)
    ui.render(stateFor({ title: 'x', createDraft: false, useTemplate: false }), 0)
    expect(ui.element.querySelector<HTMLInputElement>(selector)!.checked).toBe(true)
    await act(async () => write.reject(new Error(`${key} failed`)))
    await settle()
    expect(ui.element.querySelector<HTMLInputElement>(selector)!.checked).toBe(true)
    expect(ui.element.querySelector('[role="alert"]')?.textContent).toContain(`${key} failed`)
  })
}

test('C9 and C23: create title edits send immediately in order without blur and include generation', async () => {
  const ui = mount((props) => <CreateReview {...props} />)
  const firstWrite = ui.holdNext('quirky.reviews/createDraft')
  const title = ui.element.querySelector<HTMLInputElement>('#review-title')!
  changeValue(title, 'a')
  changeValue(title, 'ab')
  ui.render(stateFor({ title: 'a' }), 0)
  expect(ui.element.querySelector<HTMLInputElement>('#review-title')!.value).toBe('ab')
  await act(async () => firstWrite.resolve({ updated: true }))
  await settle()
  expect(callsFor(ui, 'createDraft').map((call) => call.params.title)).toEqual(['a', 'ab'])
  for (const call of callsFor(ui, 'createDraft')) paramsWith(call, { generation: 1 })
})

test('C10: posting waits for the comment draft write, then clears it with a fenced write', async () => {
  const ui = mount((props) => <Comments {...props} surface="detail" />)
  const draftWrite = ui.holdNext('quirky.reviews/detailSetCommentDraft')
  changeValue(commentComposer(ui.element), 'hello')
  await click(button(ui.element, 'Send comment'))
  expect(callCount(ui, 'detailPostComment')).toBe(0)
  ui.render(stateFor({ commentDraft: 'hello' }), 0)
  await act(async () => draftWrite.resolve({ applied: true }))
  await settle()
  expect(callCount(ui, 'detailPostComment')).toBe(1)
  paramsWith(callsFor(ui, 'detailPostComment')[0]!, { worktree: WORKTREE_A, number: 12, body: 'hello' })
  await settle()
  expect(commentComposer(ui.element).value).toBe('')
  expect(callsFor(ui, 'detailSetCommentDraft').filter((call) => call.params.body === '')).toHaveLength(1)
})

test('C11: an image inserted while posting is kept and resent after success', async () => {
  const ui = mount((props) => <Comments {...props} surface="detail" />)
  changeValue(commentComposer(ui.element), 'hello')
  await settle()
  const post = ui.holdNext('quirky.reviews/detailPostComment')
  await click(button(ui.element, 'Send comment'))
  expect(callCount(ui, 'detailPostComment')).toBe(1)
  await click(ui.element.querySelector<HTMLButtonElement>('button[aria-expanded]')!)
  changeValue(ui.element.querySelector<HTMLInputElement>('#review-image-detail')!, 'https://x.test/a.png')
  await click(button(ui.element, 'Insert image'))
  ui.render(stateFor({ commentDraft: '' }), 0)
  await act(async () => post.resolve({ posted: true }))
  await settle()
  const writes = callsFor(ui, 'detailSetCommentDraft')
  expect(writes.some((call) => call.params.body === '')).toBe(false)
  expect(writes.at(-1)?.params.body).toBe('hello\n![image](<https://x.test/a.png>)')
  expect(commentComposer(ui.element).value).toBe('hello\n![image](<https://x.test/a.png>)')
})

test('C12: a held post reply cannot clear or write into another pull request', async () => {
  const ui = mount((props) => <Comments {...props} surface="detail" />)
  changeValue(commentComposer(ui.element), 'hello')
  await settle()
  const post = ui.holdNext('quirky.reviews/detailPostComment')
  await click(button(ui.element, 'Send comment'))
  ui.render(stateFor({ number: 13, commentDraft: 'other' }), 0)
  await act(async () => post.resolve({ posted: true }))
  await settle()
  expect(commentComposer(ui.element).value).toBe('other')
  expect(callsFor(ui, 'detailSetCommentDraft').some((call) => call.params.number === 13)).toBe(false)
})

test('C24: a target change while posting waits for its draft prevents the post', async () => {
  const ui = mount((props) => <Comments {...props} surface="detail" />)
  const draftWrite = ui.holdNext('quirky.reviews/detailSetCommentDraft')
  changeValue(commentComposer(ui.element), 'hello')
  await click(button(ui.element, 'Send comment'))
  ui.render(stateFor({ number: 13, commentDraft: 'other' }), 0)
  await act(async () => draftWrite.resolve({ applied: true }))
  await settle()
  expect(callCount(ui, 'detailPostComment')).toBe(0)
  expect(commentComposer(ui.element).value).toBe('other')
  expect(ui.element.querySelector('[role="alert"]')).toBeNull()
})

test('C13: a successful body save keeps and re-sends text edited during the save', async () => {
  const ui = mount((props) => <ReviewPage {...props} />)
  await click(button(ui.element, 'Edit description'))
  const save = ui.holdNext('quirky.reviews/detailUpdateBody')
  await click(button(ui.element, 'Save description'))
  expect(callCount(ui, 'detailUpdateBody')).toBe(1)
  paramsWith(callsFor(ui, 'detailUpdateBody')[0]!, { number: 12, body: 'old body' })
  changeValue(bodyInput(ui.element), 'first and more')
  await settle()
  ui.render(stateFor({ body: 'first', bodyDraft: null }), nextDraftTick())
  expect(bodyInput(ui.element).value).toBe('first and more')
  await act(async () => save.resolve({ updated: true }))
  await settle()
  expect(bodyInput(ui.element).value).toBe('first and more')
  expect(ui.element.querySelector('[aria-label="Pull request description"]')).not.toBeNull()
  const writes = callsFor(ui, 'detailSetBodyDraft')
  expect(writes.at(-1)?.params.body).toBe('first and more')
  expect(writes.at(-1)?.params.number).toBe(12)
})

test('C13: an unchanged successful body save closes the editor without a draft write', async () => {
  const ui = mount((props) => <ReviewPage {...props} />)
  await click(button(ui.element, 'Edit description'))
  await settle()
  const writesBeforeSave = callCount(ui, 'detailSetBodyDraft')
  const save = ui.holdNext('quirky.reviews/detailUpdateBody')
  await click(button(ui.element, 'Save description'))
  await act(async () => save.resolve({ updated: true }))
  await settle()
  expect(ui.element.querySelector('textarea[aria-label="Pull request description"]')).toBeNull()
  expect(callCount(ui, 'detailSetBodyDraft')).toBe(writesBeforeSave)
})

test('C14: a held body save does not affect a different PR or save after a pre-write target change', async () => {
  const saving = mount((props) => <ReviewPage {...props} />)
  await click(button(saving.element, 'Edit description'))
  await settle()
  const save = saving.holdNext('quirky.reviews/detailUpdateBody')
  await click(button(saving.element, 'Save description'))
  saving.render(stateFor({ number: 13, body: 'other body' }), 0)
  await act(async () => save.resolve({ updated: true }))
  await settle()
  expect(saving.element.textContent).toContain('other body')
  expect(callsFor(saving, 'detailSetBodyDraft').some((call) => call.params.number === 13)).toBe(false)

  const waiting = mount((props) => <ReviewPage {...props} />)
  const draftWrite = waiting.holdNext('quirky.reviews/detailSetBodyDraft')
  await click(button(waiting.element, 'Edit description'))
  await click(button(waiting.element, 'Save description'))
  waiting.render(stateFor({ number: 13, body: 'other body' }), 0)
  await act(async () => draftWrite.resolve({ applied: true }))
  await settle()
  expect(callCount(waiting, 'detailUpdateBody')).toBe(0)
})

test('C15: a successful title save preserves an edit made while the save is held', async () => {
  const ui = mount((props) => <ChecksPanel {...props} />)
  const initialDraft = ui.holdNext('quirky.reviews/checksSetTitleDraft')
  await click(button(ui.element, 'Edit pull request title'))
  changeValue(titleInput(ui.element), 'New title')
  const save = ui.holdNext('quirky.reviews/checksSaveTitle')
  await click(button(ui.element, 'Save pull request title'))
  expect(callCount(ui, 'checksSaveTitle')).toBe(0)
  await act(async () => initialDraft.resolve({ titleDraft: 'Review 12' }))
  await settle()
  expect(callsFor(ui, 'checksSaveTitle')).toHaveLength(1)
  paramsWith(callsFor(ui, 'checksSaveTitle')[0]!, { title: 'New title', number: 12, expectedHead: 'a'.repeat(40) })
  changeValue(titleInput(ui.element), 'Newer')
  await settle()
  ui.render(stateFor({ generation: 2, titleDraft: null }), nextDraftTick())
  expect(titleInput(ui.element).value).toBe('Newer')
  const beforeReply = callCount(ui, 'checksSetTitleDraft')
  await act(async () => save.resolve({ updated: true }))
  await settle()
  expect(titleInput(ui.element).value).toBe('Newer')
  expect(callCount(ui, 'checksSetTitleDraft')).toBe(beforeReply + 1)
  paramsWith(callsFor(ui, 'checksSetTitleDraft').at(-1)!, { title: 'Newer', generation: 2, prRepo: { host: HOST, owner: 'test-owner', repo: 'test-repo' } })
})

test('C15: a failed title save keeps a newer edit held without sending it again', async () => {
  const ui = mount((props) => <ChecksPanel {...props} />)
  await click(button(ui.element, 'Edit pull request title'))
  await settle()
  const save = ui.holdNext('quirky.reviews/checksSaveTitle')
  await click(button(ui.element, 'Save pull request title'))
  changeValue(titleInput(ui.element), 'Newer')
  await settle()
  ui.render(stateFor({ titleDraft: null }), nextDraftTick())
  const beforeReply = callCount(ui, 'checksSetTitleDraft')
  await act(async () => save.resolve({ updated: false, error: 'The title could not be saved.' }))
  await settle()
  ui.render(stateFor({ titleDraft: 'Review 12' }), nextDraftTick())
  expect(titleInput(ui.element).value).toBe('Newer')
  expect(ui.element.querySelector('[role="alert"]')?.textContent).toContain('The title could not be saved.')
  expect(callCount(ui, 'checksSetTitleDraft')).toBe(beforeReply)
})

test('C16 and C23: cancelling immediately exits edit mode and fences its queued write', async () => {
  const ui = mount((props) => <ChecksPanel {...props} />)
  const draftWrite = ui.holdNext('quirky.reviews/checksSetTitleDraft')
  await click(button(ui.element, 'Edit pull request title'))
  changeValue(titleInput(ui.element), 'New title')
  await click(button(ui.element, 'Cancel title edit'))
  expect(button(ui.element, 'Edit pull request title').textContent?.trim()).toBe('Review 12')
  expect(callCount(ui, 'checksCancelTitle')).toBe(0)
  await act(async () => draftWrite.resolve({ titleDraft: 'Review 12' }))
  await settle()
  expect(callCount(ui, 'checksCancelTitle')).toBe(1)
  paramsWith(callsFor(ui, 'checksCancelTitle')[0]!, { worktree: WORKTREE_A, number: 12, generation: 1, prRepo: { host: HOST, owner: 'test-owner', repo: 'test-repo' } })
  expect(button(ui.element, 'Edit pull request title').textContent?.trim()).toBe('Review 12')
})

test('C17: a comment draft failure and its one resend stay visible without losing sendable text', async () => {
  const ui = mount((props) => <Comments {...props} surface="detail" />)
  const first = ui.holdNext('quirky.reviews/detailSetCommentDraft')
  changeValue(commentComposer(ui.element), 'hello')
  await act(async () => first.reject(new Error('The selected review surface changed before this action.')))
  await settle()
  const second = ui.holdNext('quirky.reviews/detailSetCommentDraft')
  ui.render(stateFor({ commentDraft: '' }), nextDraftTick())
  expect(callCount(ui, 'detailSetCommentDraft')).toBe(2)
  await act(async () => second.reject(new Error('The selected review surface changed before this action.')))
  await settle()
  expect(commentComposer(ui.element).value).toBe('hello')
  expect(ui.element.querySelector('[role="alert"]')?.textContent).toContain('The selected review surface changed before this action.')
  await click(button(ui.element, 'Send comment'))
  expect(callCount(ui, 'detailPostComment')).toBe(1)
  paramsWith(callsFor(ui, 'detailPostComment')[0]!, { body: 'hello' })
})

test('C18: changing PR number adopts its comment draft', () => {
  const ui = mount((props) => <Comments {...props} surface="detail" />)
  changeValue(commentComposer(ui.element), 'ab')
  ui.render(stateFor({ number: 13, commentDraft: 'other' }), 0)
  expect(commentComposer(ui.element).value).toBe('other')
})

test('C19: same-number repository relinks discard the queued comment text and stale error', async () => {
  const ui = mount((props) => <Comments {...props} surface="detail" />)
  const first = ui.holdNext('quirky.reviews/detailSetCommentDraft')
  changeValue(commentComposer(ui.element), 'ab')
  changeValue(commentComposer(ui.element), 'abc')
  ui.render(stateFor({ repoOwner: 'other-owner', commentDraft: '' }), 0)
  expect(commentComposer(ui.element).value).toBe('')
  await act(async () => first.reject(new Error('stale target')))
  await settle()
  expect(ui.element.querySelector('[role="alert"]')).toBeNull()
  expect(callsFor(ui, 'detailSetCommentDraft').some((call) => call.params.prRepo && (call.params.prRepo as { owner?: string }).owner === 'other-owner' && call.params.body === 'abc')).toBe(false)
})

test('C19: same-number repository relinks discard the queued description text', async () => {
  const ui = mount((props) => <ReviewPage {...props} />)
  const first = ui.holdNext('quirky.reviews/detailSetBodyDraft')
  await click(button(ui.element, 'Edit description'))
  changeValue(bodyInput(ui.element), 'ab')
  changeValue(bodyInput(ui.element), 'abc')
  ui.render(stateFor({ repoOwner: 'other-owner', body: 'other body' }), 0)
  await act(async () => first.reject(new Error('stale target')))
  await settle()
  expect(ui.element.textContent).toContain('other body')
  expect([...ui.element.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)).toEqual([])
  expect(callsFor(ui, 'detailSetBodyDraft').some((call) => call.params.prRepo && (call.params.prRepo as { owner?: string }).owner === 'other-owner' && call.params.body === 'abc')).toBe(false)
})

test('C19: same-number repository relinks discard the queued title text', async () => {
  const ui = mount((props) => <ChecksPanel {...props} />)
  const first = ui.holdNext('quirky.reviews/checksSetTitleDraft')
  await click(button(ui.element, 'Edit pull request title'))
  changeValue(titleInput(ui.element), 'ab')
  changeValue(titleInput(ui.element), 'abc')
  ui.render(stateFor({ repoOwner: 'other-owner', titleDraft: null }), 0)
  await act(async () => first.reject(new Error('stale target')))
  await settle()
  expect(button(ui.element, 'Edit pull request title').textContent?.trim()).toBe('Review 12')
  expect([...ui.element.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)).toEqual([])
  expect(callsFor(ui, 'checksSetTitleDraft').some((call) => call.params.prRepo && (call.params.prRepo as { owner?: string }).owner === 'other-owner' && call.params.title === 'abc')).toBe(false)
})

test('C19: same-number repository relinks discard the queued files view', async () => {
  const ui = mount((props) => <FilesChanged {...props} />)
  const first = ui.holdNext('quirky.reviews/detailSetFilesView')
  changeValue(fileFilter(ui.element), 'src')
  changeValue(fileFilter(ui.element), 'src/a')
  ui.render(stateFor({ repoOwner: 'other-owner', fileFilter: '' }), 0)
  expect(fileFilter(ui.element).value).toBe('')
  await act(async () => first.reject(new Error('stale target')))
  await settle()
  expect(ui.element.querySelector('[role="alert"]')).toBeNull()
  expect(callsFor(ui, 'detailSetFilesView').some((call) => call.params.prRepo && (call.params.prRepo as { owner?: string }).owner === 'other-owner' && call.params.fileFilter === 'src/a')).toBe(false)
})

test('C19 and C23: comment and body writers retry a false applied reply with a rebased version', async () => {
  const comments = mount((props) => <Comments {...props} surface="detail" />)
  comments.replyNext('quirky.reviews/detailSetCommentDraft', { applied: false })
  comments.replyNext('quirky.reviews/detailSetCommentDraft', { applied: true })
  const commentRetryFloor = Date.now() * 1000
  changeValue(commentComposer(comments.element), 'comment')
  await settle()
  const commentWrites = callsFor(comments, 'detailSetCommentDraft')
  expect(commentWrites.map((call) => call.params.body)).toEqual(['comment', 'comment'])
  expect(Number(commentWrites[1]!.params.draftVersion)).toBeGreaterThanOrEqual(commentRetryFloor)
  for (const call of commentWrites) paramsWith(call, { generation: 1, prRepo: { host: HOST, owner: 'test-owner', repo: 'test-repo' } })

  const body = mount((props) => <ReviewPage {...props} />)
  await click(button(body.element, 'Edit description'))
  await settle()
  body.replyNext('quirky.reviews/detailSetBodyDraft', { applied: false })
  body.replyNext('quirky.reviews/detailSetBodyDraft', { applied: true })
  const bodyRetryFloor = Date.now() * 1000
  changeValue(bodyInput(body.element), 'new body')
  await settle()
  const bodyWrites = callsFor(body, 'detailSetBodyDraft').filter((call) => call.params.body === 'new body')
  expect(bodyWrites).toHaveLength(2)
  expect(Number(bodyWrites[1]!.params.draftVersion)).toBeGreaterThanOrEqual(bodyRetryFloor)
  for (const call of bodyWrites) paramsWith(call, { generation: 1, prRepo: { host: HOST, owner: 'test-owner', repo: 'test-repo' } })
})

test('C20: generated output from an old worktree cannot overwrite the new form', async () => {
  const ui = mount((props) => <CreateReview {...props} />, stateFor({ creationWorktree: WORKTREE_A, creationGeneration: 1, title: 'A title' }))
  const generate = ui.holdNext('quirky.reviews/createGenerate')
  await click(button(ui.element, 'Generate PR details with AI'))
  expect(callCount(ui, 'createGenerate')).toBe(1)
  ui.render(stateFor({ worktree: WORKTREE_B, creationWorktree: WORKTREE_B, creationGeneration: 2, title: '', createBody: '' }), 0)
  changeValue(ui.element.querySelector<HTMLInputElement>('#review-title')!, 'b title')
  await act(async () => generate.resolve({ title: 'A generated', body: 'A body' }))
  await settle()
  expect(ui.element.querySelector<HTMLInputElement>('#review-title')!.value).toBe('b title')
  expect(ui.element.querySelector<HTMLTextAreaElement>('#review-body')!.value).toBe('')
  expect(ui.element.querySelector('[role="alert"]')).toBeNull()
  expect(callsFor(ui, 'createDraft').some((call) => call.params.worktree === WORKTREE_B && call.params.title === 'A generated')).toBe(false)
})

test('C21: submit state and errors belong to their worktree epoch, including A to B to A', async () => {
  const ui = mount((props) => <CreateReview {...props} />, stateFor({ creationWorktree: WORKTREE_A, creationGeneration: 1, title: 'A title' }))
  const oldSubmit = ui.holdNext('quirky.reviews/createSubmit')
  await click(button(ui.element, 'Create PR'))
  await settle()
  expect(callCount(ui, 'createSubmit')).toBe(1)

  ui.render(stateFor({ worktree: WORKTREE_B, creationWorktree: WORKTREE_B, creationGeneration: 2, title: 'B title' }), 0)
  expect(button(ui.element, 'Create PR').disabled).toBe(false)
  expect(button(ui.element, 'Create PR').textContent?.trim()).toBe('Create PR')
  ui.render(stateFor({ creationWorktree: WORKTREE_A, creationGeneration: 3, title: 'Return title' }), 0)
  expect(button(ui.element, 'Create PR').disabled).toBe(false)

  const newSubmit = ui.holdNext('quirky.reviews/createSubmit')
  await click(button(ui.element, 'Create PR'))
  await settle()
  expect(callCount(ui, 'createSubmit')).toBe(2)
  const refreshCountBeforeOldReply = ui.refreshedWorktrees.length
  await act(async () => oldSubmit.reject(new Error('old worktree failed')))
  await settle()
  expect(ui.element.querySelector('[role="alert"]')).toBeNull()
  expect(ui.refreshedWorktrees).toHaveLength(refreshCountBeforeOldReply)
  expect(button(ui.element, 'Creating…').textContent?.trim()).toBe('Creating…')
  expect(button(ui.element, 'Creating…').disabled).toBe(true)
  await act(async () => newSubmit.resolve({ submitted: true }))
  await settle()
  expect(button(ui.element, 'Create PR').textContent?.trim()).toBe('Create PR')
})

test('C22: a rejected eligibility refresh from the old worktree cannot show an error in the new one', async () => {
  const ui = mount((props) => <CreateReview {...props} />, stateFor({ creationWorktree: WORKTREE_A }))
  const refresh = ui.holdNext('quirky.reviews/createOpen')
  await click(button(ui.element, 'Refresh eligibility'))
  expect(callCount(ui, 'createOpen')).toBe(1)
  ui.render(stateFor({ worktree: WORKTREE_B, creationWorktree: WORKTREE_B, creationGeneration: 2 }), 0)
  await act(async () => refresh.reject(new Error('old eligibility failed')))
  await settle()
  expect(ui.element.querySelector('[role="alert"]')).toBeNull()
})

test('C22: a late Open review reply cannot show an old worktree error', async () => {
  const ui = mount((props) => <CreateReview {...props} />, stateFor({
    creationWorktree: WORKTREE_A,
    result: { status: 'created', review: { number: 12, url: 'https://github.com/test-owner/test-repo/pull/12' } }
  }))
  const open = ui.holdNext('quirky.reviews/createOpen')
  await click(button(ui.element, 'Open review'))
  ui.render(stateFor({ worktree: WORKTREE_B, creationWorktree: WORKTREE_B, creationGeneration: 2 }), 0)
  await act(async () => open.reject(new Error('old open failed')))
  await settle()
  expect(ui.element.querySelector('[role="alert"]')).toBeNull()
})

test('C22: Stop generation cannot publish an old worktree error after a target change', async () => {
  const ui = mount((props) => <CreateReview {...props} />, stateFor({ creationWorktree: WORKTREE_A, generating: true }))
  const stop = ui.holdNext('quirky.reviews/createCancelGenerate')
  await click(button(ui.element, 'Stop generating pull-request details'))
  ui.render(stateFor({ worktree: WORKTREE_B, creationWorktree: WORKTREE_B, creationGeneration: 2 }), 0)
  await act(async () => stop.reject(new Error('old stop failed')))
  await settle()
  expect(ui.element.querySelector('[role="alert"]')).toBeNull()
})

test('C25: a failed body save keeps edits made during the save without resending them', async () => {
  const ui = mount((props) => <ReviewPage {...props} />)
  await click(button(ui.element, 'Edit description'))
  await settle()
  const save = ui.holdNext('quirky.reviews/detailUpdateBody')
  await click(button(ui.element, 'Save description'))
  changeValue(bodyInput(ui.element), 'first and more')
  await settle()
  ui.render(stateFor({ bodyDraft: null }), nextDraftTick())
  const writesBeforeFailure = callCount(ui, 'detailSetBodyDraft')
  await act(async () => save.reject(new Error('Description save failed.')))
  await settle()
  expect(bodyInput(ui.element).value).toBe('first and more')
  expect(ui.element.querySelector('[role="alert"]')?.textContent).toContain('Description save failed.')
  expect(callCount(ui, 'detailSetBodyDraft')).toBe(writesBeforeFailure)
})

for (const action of ['post', 'body save', 'title save', 'generation'] as const) {
  test(`C26: duplicate ${action} activation starts only one daemon action`, async () => {
    if (action === 'post') {
      const ui = mount((props) => <Comments {...props} surface="detail" />)
      changeValue(commentComposer(ui.element), 'hello')
      await settle()
      ui.holdNext('quirky.reviews/detailPostComment')
      const send = button(ui.element, 'Send comment')
      await act(async () => { send.click(); send.click() })
      expect(callCount(ui, 'detailPostComment')).toBe(1)
    } else if (action === 'body save') {
      const ui = mount((props) => <ReviewPage {...props} />)
      await click(button(ui.element, 'Edit description'))
      await settle()
      ui.holdNext('quirky.reviews/detailUpdateBody')
      const save = button(ui.element, 'Save description')
      await act(async () => { save.click(); save.click() })
      expect(callCount(ui, 'detailUpdateBody')).toBe(1)
    } else if (action === 'title save') {
      const ui = mount((props) => <ChecksPanel {...props} />)
      await click(button(ui.element, 'Edit pull request title'))
      await settle()
      ui.holdNext('quirky.reviews/checksSaveTitle')
      const save = button(ui.element, 'Save pull request title')
      await act(async () => { save.click(); save.click() })
      expect(callCount(ui, 'checksSaveTitle')).toBe(1)
    } else {
      const ui = mount((props) => <CreateReview {...props} />)
      ui.holdNext('quirky.reviews/createGenerate')
      const generate = button(ui.element, 'Generate PR details with AI')
      await act(async () => { generate.click(); generate.click() })
      expect(callCount(ui, 'createGenerate')).toBe(1)
    }
  })
}

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
})

afterAll(() => GlobalRegistrator.unregister())

for (const field of ['comment', 'body'] as const) {
  for (const leave of ['target change', 'unmount'] as const) {
    test(`D16/D19: ${field} version retry stops after ${leave}`, async () => {
      const render = (props: RenderProps) => field === 'comment'
        ? <Comments {...props} surface="detail" />
        : <ReviewPage {...props} />
      const ui = mount(render)
      const method = field === 'comment' ? 'detailSetCommentDraft' : 'detailSetBodyDraft'
      const first = ui.holdNext(`quirky.reviews/${method}`)
      if (field === 'comment') changeValue(commentComposer(ui.element), 'old mount')
      else await click(button(ui.element, 'Edit description'))
      expect(callCount(ui, method)).toBe(1)

      if (leave === 'target change') {
        ui.render(stateFor({ repoOwner: 'other-owner', commentDraft: 'other', body: 'other' }), 0)
      } else {
        ui.unmount()
        const remounted = mount(render)
        if (field === 'comment') changeValue(commentComposer(remounted.element), 'new mount')
        else {
          await click(button(remounted.element, 'Edit description'))
          changeValue(bodyInput(remounted.element), 'new mount')
        }
        await settle()
      }
      const refreshes = ui.refreshedWorktrees.length
      await act(async () => first.resolve({ applied: false }))
      await settle()
      expect(callCount(ui, method)).toBe(1)
      expect(ui.refreshedWorktrees).toHaveLength(refreshes)
    })
  }
}
