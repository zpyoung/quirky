import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import type { Fake } from './panel-support'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Load React-bound test and view modules only after happy-dom is registered.
const p = await import('./panel-support')
const s = await import('./support')
const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { EditorView } = await import('@codemirror/view')
const { mountDiffView } = await import('../../src/view/DiffWindow')
const { openDiffView } = await import('../../src/view/registry')
const { DIFF_SURFACE, requestViewControl, useViewControl, viewControlGeneration, viewTarget } = await import('../../src/view/view-control')
const { GIT_UI_CONTROL_COMMAND, dispatchGitUiControl, mountGitUiControls } = await import('../../src/ui-control')
const { activate } = await import('../../src/ui')

afterAll(() => GlobalRegistrator.unregister())

const { act, byLabel, byText, click, failure, fakeContext, layoutFor, press, settle, statusOf, entry } = p

type ControlAddress = { surface: string; target: string; generation: string; actions: string[] }
type Report = Record<string, unknown> & { uiControls?: ControlAddress[] }
type Mounted = { element: HTMLElement; reports: Report[]; unmount(): void }
type Control = { surface: string; target: string; generation: string; action: string; data?: Record<string, unknown> }

let intersection: { restore(): void } | null = null
let resize: { restore(): void } | null = null
const liveUnmounts = new Set<() => void>()

const twoBlocks = [
  'before',
  '<<<<<<< HEAD',
  'ours',
  '=======',
  'theirs',
  '>>>>>>> topic',
  'between',
  '<<<<<<< HEAD',
  'ours again',
  '||||||| base',
  'base',
  '=======',
  'theirs again',
  '>>>>>>> topic',
  'after',
  ''
].join('\n')

const conflictFile = (overrides: Record<string, unknown> = {}) => ({
  path: 'math.ts',
  kind: 'both_modified',
  state: 'unresolved',
  content: twoBlocks,
  hash: 'h-conflict',
  operation: 'merge',
  ...overrides
})

const conflictEntry = (path = 'math.ts', state: 'unresolved' | 'resolved_locally' = 'unresolved') => ({
  path,
  area: 'conflicts' as const,
  status: 'modified' as const,
  conflict: { kind: 'both_modified' as const, state }
})

const note = {
  id: 'n1', worktreeId: 'w1', path: 'a.ts', startLine: 1, line: 1,
  body: 'Keep this line', createdAt: 1, updatedAt: null
}

function makeReviewFake(connId = 22, marks: Record<string, 'none' | 'reviewed' | 'changed'> = {}): Fake {
  const fake = fakeContext(layoutFor('w1'), connId)
  fake.status = statusOf([entry('a.ts'), entry('guide.md')])
  const files = [
    s.reviewFile('a.ts', { mark: marks['a.ts'] ?? 'none' }),
    s.reviewFile('guide.md', { mark: marks['guide.md'] ?? 'none' })
  ]
  fake.on('quirky.git/review', () => s.reviewModel(files))
  fake.on('quirky.git/diff', (params) => s.textDiff({
    path: String(params.path),
    source: 'review',
    modifiedHash: 'h1',
    original: 'old line\n',
    modified: 'new line\n'
  }))
  fake.on('quirky.git/commitFiles', (params) => ({
    commit: String(params.commit),
    entries: [{ path: 'a.ts', status: 'modified', added: 1, removed: 1, binary: false }]
  }))
  fake.on('quirky.editor/markdownPreview', (params) => params.action === 'render'
    ? { leaseId: params.leaseId, worktreeId: 'w1', path: params.path, html: '<p>rendered</p>' }
    : {})
  fake.on('quirky.git/notes', () => ({ notes: [] }))
  return fake
}

function makeConflictFileFake(connId = 22, result: Record<string, unknown> = conflictFile()): Fake {
  const fake = fakeContext(layoutFor('w1'), connId)
  fake.status = statusOf([conflictEntry()])
  fake.on('quirky.git/conflictFile', () => result)
  fake.on('quirky.git/status', () => fake.status)
  return fake
}

function makeConflictsFake(connId = 22): Fake {
  const fake = fakeContext(layoutFor('w1'), connId)
  fake.status = statusOf([conflictEntry('a.ts')])
  fake.on('quirky.git/status', () => fake.status)
  fake.on('quirky.git/conflictFile', (params) => ({ path: params.path, content: 'file content\n' }))
  return fake
}

function mountView(fake: Fake, input: object): Mounted {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const reports: Report[] = []
  let cleanup: (() => void) | void
  const mount = mountGitUiControls(fake.context, DIFF_SURFACE, mountDiffView)
  act(() => {
    cleanup = mount(element, { input, report: (state) => reports.push(state as Report) })
  })
  let done = false
  const unmount = () => {
    if (done) return
    done = true
    liveUnmounts.delete(unmount)
    act(() => cleanup?.())
    element.remove()
  }
  liveUnmounts.add(unmount)
  return { element, reports, unmount }
}

const controlsOf = (mounted: Mounted): ControlAddress[] => mounted.reports.at(-1)?.uiControls ?? []
const addressOf = (mounted: Mounted, target: string): ControlAddress => {
  const found = controlsOf(mounted).find((candidate) => candidate.target === target)
  if (!found) throw new Error(`No mounted control for ${target}: ${JSON.stringify(controlsOf(mounted))}`)
  return found
}
const control = (address: ControlAddress, action: string, data?: Record<string, unknown>): Control => ({
  surface: address.surface,
  target: address.target,
  generation: address.generation,
  action,
  ...(data === undefined ? {} : { data })
})
const commandHandler = (fake: Fake) => {
  const handler = fake.provided.get(GIT_UI_CONTROL_COMMAND)
  if (typeof handler !== 'function') throw new Error('The activated UI control command is not provided')
  return handler as (args: unknown) => unknown
}
const dispatch = (fake: Fake, args: Control | Record<string, unknown>) => commandHandler(fake)(args)
const dispatchInAct = async (fake: Fake, args: Control | Record<string, unknown>) => {
  let result: unknown
  await act(async () => { result = dispatch(fake, args) })
  await settle()
  return result
}
const bridge = async (fake: Fake, args: Control) => {
  let result: unknown
  await act(async () => {
    result = await fake.context.call('ui.window.command.run', {
      connId: fake.connId,
      id: GIT_UI_CONTROL_COMMAND,
      args
    })
  })
  await settle()
  return result
}
const sortedActions = (address: ControlAddress) => [...address.actions].sort()
const button = (root: ParentNode, text: string): HTMLButtonElement | null => {
  const found = byText(root, 'button', text)
  return found ? found as HTMLButtonElement : null
}
const editorFor = (root: ParentNode, selector = '.cm-editor'): InstanceType<typeof EditorView> => {
  const element = root.querySelector<HTMLElement>(selector)
  if (!element) throw new Error(`No CodeMirror editor at ${selector}`)
  const view = EditorView.findFromDOM(element)
  if (!view) throw new Error(`No CodeMirror view at ${selector}`)
  return view
}
const daemonCalls = (fake: Fake) => fake.calls.filter(({ method }) => method.startsWith('quirky.git/') || method.startsWith('quirky.editor/'))
const dialogAddress = (mounted: Mounted) => addressOf(mounted, 'close-dialog:w1')
const openDirtyDialog = async (mounted: Mounted) => {
  await act(async () => editorFor(mounted.element).dispatch({ changes: { from: 0, to: 0, insert: '// draft\n' } }))
  await settle()
  await click(byLabel(mounted.element, 'Close'))
  expect(mounted.element.querySelector('[role="dialog"]')).not.toBeNull()
  return dialogAddress(mounted)
}

beforeEach(() => {
  document.body.innerHTML = ''
  intersection = s.stubIntersectionObserver()
  resize = s.stubResizeObserver()
})
afterEach(async () => {
  for (const unmount of [...liveUnmounts]) unmount()
  await settle()
  intersection?.restore()
  intersection = null
  resize?.restore()
  resize = null
})

describe('view control helper', () => {
  test('uses fresh scoped targets and generations', () => {
    const first = viewControlGeneration()
    const second = viewControlGeneration()
    expect(first).not.toBe(second)
    expect(viewTarget('review', { worktree: 'w1' })).toBe('review:w1')
    expect(viewTarget('review', { worktree: 'w1', tabId: 'tab-7' })).toBe('review:w1:tab-7')
    expect(viewTarget('conflicts', { worktree: 'w1', tabId: 'tab-7' })).toBe('conflicts:w1:tab-7')
    expect(viewTarget('conflict-file', { worktree: 'w1', tabId: 'tab-7', path: 'src/math.ts' })).toBe('conflict-file:w1:tab-7:src/math.ts')
    expect(viewTarget('close-dialog', { worktree: 'w1' })).toBe('close-dialog:w1')
  })

  test('registers after commit, calls the latest handler, disposes, and never throws from requests', async () => {
    const fake = fakeContext(layoutFor(null), 22)
    activate(fake.context)
    const rootElement = document.createElement('div')
    document.body.appendChild(rootElement)
    const root = createRoot(rootElement)
    const address = { target: 'test:w1', generation: 'hook-1', actions: ['run'] }
    let firstCalls = 0
    let latestCalls = 0
    const Harness = (props: { active: boolean; handler: () => boolean }) => {
      useViewControl(fake.context, props.active ? address : null, props.handler)
      return null
    }
    await act(async () => {
      root.render(createElement(Harness, { active: true, handler: () => { firstCalls++; return true } }))
    })
    expect(dispatchGitUiControl(fake.context, {
      surface: DIFF_SURFACE, target: address.target, generation: address.generation, action: 'run'
    })).toEqual({ delivered: true })
    await act(async () => {
      root.render(createElement(Harness, { active: true, handler: () => { latestCalls++; return true } }))
    })
    expect(dispatchGitUiControl(fake.context, {
      surface: DIFF_SURFACE, target: address.target, generation: address.generation, action: 'run'
    })).toEqual({ delivered: true })
    expect(firstCalls).toBe(1)
    expect(latestCalls).toBe(1)

    await act(async () => root.render(createElement(Harness, { active: false, handler: () => true })))
    expect(dispatchGitUiControl(fake.context, {
      surface: DIFF_SURFACE, target: address.target, generation: address.generation, action: 'run'
    })).toEqual({ delivered: false })

    await act(async () => root.render(createElement(Harness, { active: true, handler: () => true })))
    await expect(requestViewControl(fake.context, {
      target: 'missing:w1', generation: 'missing-generation', action: 'run'
    })).resolves.toBe(false)
    fake.on('ui.window.command.run', () => { throw failure('bridge down') })
    await expect(requestViewControl(fake.context, {
      target: address.target, generation: address.generation, action: 'run'
    })).resolves.toBe(false)
    expect(fake.toasts.at(-1)).toEqual(['Could not run Source Control action', 'bridge down'])
    expect(fake.toastOptions.at(-1)).toEqual({ kind: 'error' })

    await act(async () => root.unmount())
    rootElement.remove()
  })
})

describe('review controls', () => {
  test('publishes one merged review address and routes visible controls through the exact window', async () => {
    const fake = makeReviewFake(22)
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    const address = addressOf(mounted, 'review:w1')
    expect(controlsOf(mounted)).toHaveLength(1)
    expect(address.surface).toBe(DIFF_SURFACE)
    expect(sortedActions(address)).toEqual(['collapse', 'collapse-all', 'layout', 'mark', 'preview'])

    await click(button(mounted.element, 'Collapse all'))
    const collapsedRequest = fake.called('ui.window.command.run').at(-1)
    expect(collapsedRequest?.params).toEqual({
      connId: 22,
      id: GIT_UI_CONTROL_COMMAND,
      args: control(address, 'collapse-all', { collapsed: true })
    })
    expect(button(mounted.element, 'Expand all')).not.toBeNull()
    const collapsedDom = mounted.element.innerHTML
    expect(await dispatchInAct(fake, control(address, 'collapse-all', { collapsed: true }))).toEqual({ delivered: true })
    expect(mounted.element.innerHTML).toBe(collapsedDom)

    await click(byLabel(mounted.element, 'Switch to side-by-side diff'))
    expect(byLabel(mounted.element, 'Switch to inline diff')).not.toBeNull()
    expect(fake.called('ui.window.command.run').at(-1)?.params.args).toEqual(control(address, 'layout', { layout: 'side-by-side' }))
  })

  test('routes a card collapse idempotently and previews only loaded Markdown', async () => {
    const fake = makeReviewFake()
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    const address = addressOf(mounted, 'review:w1')

    await click(byLabel(mounted.element, 'Collapse a.ts'))
    expect(fake.called('ui.window.command.run').at(-1)?.params.args).toEqual(control(address, 'collapse', { path: 'a.ts', collapsed: true }))
    const afterCollapse = mounted.element.innerHTML
    expect(await dispatchInAct(fake, control(address, 'collapse', { path: 'a.ts', collapsed: true }))).toEqual({ delivered: true })
    expect(mounted.element.innerHTML).toBe(afterCollapse)

    await click(button(mounted.element, 'Preview'))
    expect(fake.called('ui.window.command.run').at(-1)?.params.args).toEqual(control(address, 'preview', { path: 'guide.md', preview: true }))
    expect(fake.called('quirky.editor/markdownPreview').filter(({ params }) => params.action === 'render')).toHaveLength(1)
    expect(mounted.element.querySelector('[data-markdown-preview]')).not.toBeNull()
  })

  test('marks a card with an explicit reviewed value and accepts an already-matching value without a call', async () => {
    const fake = makeReviewFake(22, { 'a.ts': 'none' })
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    const address = addressOf(mounted, 'review:w1')
    expect(await bridge(fake, control(address, 'mark', { path: 'a.ts', reviewed: true }))).toEqual({ result: { delivered: true } })
    expect(fake.called('quirky.git/setReviewMark')).toEqual([{
      method: 'quirky.git/setReviewMark',
      params: { worktree: 'w1', path: 'a.ts', reviewed: true, expected: 'h1' }
    }])

    const alreadyReviewed = makeReviewFake(22, { 'a.ts': 'reviewed' })
    activate(alreadyReviewed.context)
    const second = mountView(alreadyReviewed, { worktree: 'w1', mode: 'review' })
    await settle()
    const secondAddress = addressOf(second, 'review:w1')
    const before = second.element.innerHTML
    expect(await dispatchInAct(alreadyReviewed, control(secondAddress, 'mark', { path: 'a.ts', reviewed: true }))).toEqual({ delivered: true })
    expect(alreadyReviewed.called('quirky.git/setReviewMark')).toHaveLength(0)
    expect(second.element.querySelector('[data-path="a.ts"]')?.getAttribute('data-active')).toBe(
      before.includes('data-active=""') ? '' : null
    )
  })

  test.each(['none', 'changed'] as const)('clearing an already-unreviewed %s mark is idempotent', async (mark) => {
    const fake = makeReviewFake(22, { 'a.ts': mark })
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    const address = addressOf(mounted, 'review:w1')
    expect(await dispatchInAct(fake, control(address, 'mark', { path: 'a.ts', reviewed: false }))).toEqual({ delivered: true })
    expect(fake.called('quirky.git/setReviewMark')).toHaveLength(0)
  })
  test('same-turn mark requests reserve the path before starting a second mutation', async () => {
    const fake = makeReviewFake()
    const heldMark = Promise.withResolvers<unknown>()
    fake.on('quirky.git/setReviewMark', () => heldMark.promise)
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    const address = addressOf(mounted, 'review:w1')
    let first: unknown
    let second: unknown
    await act(async () => {
      first = dispatch(fake, control(address, 'mark', { path: 'a.ts', reviewed: true }))
      second = dispatch(fake, control(address, 'mark', { path: 'a.ts', reviewed: false }))
    })
    expect(first).toEqual({ delivered: true })
    expect(second).toEqual({ delivered: false })
    expect(fake.called('quirky.git/setReviewMark')).toHaveLength(1)
    await act(async () => heldMark.resolve({ ok: true }))
    await settle()
  })

  test('refuses malformed, unknown, out-of-scope, and ineligible review actions without changing the view', async () => {
    const fake = makeReviewFake(22, { 'guide.md': 'changed' })
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    const address = addressOf(mounted, 'review:w1')
    const originalDom = mounted.element.innerHTML
    const originalDaemon = daemonCalls(fake)
    const invalid: Control[] = [
      control({ ...address, target: 'review:other' }, 'collapse-all', { collapsed: true }),
      control(address, 'missing-action'),
      control(address, 'collapse-all', {}),
      control(address, 'collapse-all', { collapsed: 'true' as unknown as boolean }),
      control(address, 'layout', { layout: 'vertical' }),
      control(address, 'layout', { layout: 'inline', extra: true }),
      control(address, 'collapse', { path: 'a.ts' } as unknown as Record<string, unknown>),
      control(address, 'collapse', { path: 'a.ts', collapsed: 1 as unknown as boolean }),
      control(address, 'collapse', { path: 'a.ts', collapsed: true, extra: true }),
      control(address, 'collapse', { path: 'missing.ts', collapsed: true }),
      control(address, 'preview', { path: 'guide.md' } as unknown as Record<string, unknown>),
      control(address, 'preview', { path: 'guide.md', preview: 1 as unknown as boolean }),
      control(address, 'preview', { path: 'guide.md', preview: true, extra: true }),
      control(address, 'preview', { path: 'a.ts', preview: true }),
      control(address, 'preview', { path: 1 as unknown as string, preview: true }),
      control(address, 'mark', { path: 'a.ts' } as unknown as Record<string, unknown>),
      control(address, 'mark', { path: 'a.ts', reviewed: 'true' as unknown as boolean }),
      control(address, 'mark', { path: 1 as unknown as string, reviewed: true }),
      control(address, 'mark', { path: 'a.ts', reviewed: true, extra: true }),
      control(address, 'mark', { path: 'missing.ts', reviewed: true }),
      control(address, 'full-diff', { path: 'a.ts' }),
      control(address, 'reload', { path: 'a.ts' }),
      control(address, 'retry'),
      control(address, 'scope-clear')
    ]
    for (const candidate of invalid) {
      expect(await dispatchInAct(fake, candidate)).toEqual({ delivered: false })
    }
    expect(mounted.element.innerHTML).toBe(originalDom)
    expect(daemonCalls(fake)).toEqual(originalDaemon)
  })

  test('scoped reviews refuse mark, and old generations stop working after scope changes and remounts', async () => {
    const fake = makeReviewFake()
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review', commit: 'c'.repeat(40) })
    await settle()
    const scoped = addressOf(mounted, 'review:w1')
    expect(sortedActions(scoped)).not.toContain('mark')
    let scopeClear: unknown
    let repeatedScopeClear: unknown
    await act(async () => {
      scopeClear = dispatch(fake, control(scoped, 'scope-clear'))
      repeatedScopeClear = dispatch(fake, control(scoped, 'scope-clear'))
    })
    expect(scopeClear).toEqual({ delivered: true })
    expect(repeatedScopeClear).toEqual({ delivered: false })
    await settle()
    const current = addressOf(mounted, 'review:w1')
    expect(current.generation).not.toBe(scoped.generation)
    expect(await dispatchInAct(fake, control(scoped, 'layout', { layout: 'side-by-side' }))).toEqual({ delivered: false })

    mounted.unmount()
    const remounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    const next = addressOf(remounted, 'review:w1')
    expect(next.generation).not.toBe(current.generation)
    expect(await dispatchInAct(fake, control(current, 'layout', { layout: 'side-by-side' }))).toEqual({ delivered: false })
  })
  test('a changed card refuses Full diff while its pane is dirty', async () => {
    const fake = makeReviewFake(22, { 'a.ts': 'changed' })
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    const address = addressOf(mounted, 'review:w1')
    expect(sortedActions(address)).toContain('full-diff')
    await act(async () => editorFor(mounted.element, '[data-path="a.ts"] .cm-editor').dispatch({
      changes: { from: 0, to: 0, insert: 'draft\n' }
    }))
    await settle()
    const originalDom = mounted.element.innerHTML
    expect(await dispatchInAct(fake, control(address, 'full-diff', { path: 'a.ts' }))).toEqual({ delivered: false })
    expect(mounted.element.innerHTML).toBe(originalDom)
    expect(fake.called('quirky.git/diff')).toHaveLength(2)
  })

  test('a card Retry is routed as load, and load is refused when no card offers it', async () => {
    const fake = makeReviewFake()
    let reads = 0
    fake.on('quirky.git/diff', (params) => {
      reads++
      if (reads === 1) throw failure('git exploded')
      return s.textDiff({ path: String(params.path), source: 'review', modifiedHash: 'h1', original: 'old\n', modified: 'new\n' })
    })
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    const address = addressOf(mounted, 'review:w1')
    expect(sortedActions(address)).toContain('load')
    await click(button(mounted.element, 'Retry'))
    expect(fake.called('ui.window.command.run').at(-1)?.params.args).toEqual(control(address, 'load', { path: 'a.ts' }))
    expect(fake.called('quirky.git/diff')).toHaveLength(3)
    expect(mounted.element.querySelector('[data-diff-editor]')).not.toBeNull()
  })

  test('notes controls merge with the review address on the same diff mount', async () => {
    const fake = makeReviewFake()
    fake.on('quirky.git/notes', () => ({ notes: [note] }))
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    const controls = controlsOf(mounted)
    expect(controls.map(({ target }) => target).sort()).toEqual(['notes:w1', 'review:w1'])
    expect(controls.find(({ target }) => target === 'review:w1')?.surface).toBe(DIFF_SURFACE)
  })

  test('each review mount keeps its exact window context', async () => {
    const owner = makeReviewFake(11)
    const auxiliary = makeReviewFake(22)
    activate(owner.context)
    activate(auxiliary.context)
    const ownerView = mountView(owner, { worktree: 'w1', mode: 'review' })
    const auxiliaryView = mountView(auxiliary, { worktree: 'w1', mode: 'review' })
    await settle()
    await click(button(auxiliaryView.element, 'Collapse all'))
    expect(auxiliary.called('ui.window.command.run').at(-1)?.params.connId).toBe(22)
    expect(ownerView.element.querySelector('[data-review-body]')?.hasAttribute('hidden')).toBe(false)
    expect(auxiliaryView.element.querySelector('[data-review-body]')?.hasAttribute('hidden')).toBe(true)
  })
})

describe('conflict controls', () => {
  test('the conflict file address offers only its current actions and the first status remains the badge', async () => {
    const fake = makeConflictFileFake()
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    const address = addressOf(mounted, 'conflict-file:w1:math.ts')
    expect(controlsOf(mounted)).toHaveLength(1)
    expect(sortedActions(address)).toEqual(['close', 'next-conflict', 'previous-conflict'])
    expect(mounted.element.querySelectorAll('[role="status"]')[0]?.textContent).toContain('Unresolved conflict')

    await click(byLabel(mounted.element, 'Next conflict'))
    expect(fake.called('ui.window.command.run').at(-1)?.params).toEqual({
      connId: 22,
      id: GIT_UI_CONTROL_COMMAND,
      args: control(address, 'next-conflict')
    })
    expect(mounted.element.querySelectorAll('[role="status"]')[0]?.textContent).toContain('Unresolved conflict')
    expect(mounted.element.querySelector('[aria-label="Conflict 2 of 2"]')).not.toBeNull()
    expect(await dispatchInAct(fake, control(address, 'next-conflict', { extra: true }))).toEqual({ delivered: false })
    await click(byLabel(mounted.element, 'Close'))
    expect(fake.called('ui.window.command.run').at(-1)?.params.args).toMatchObject({ action: 'close' })

    const hostedFake = makeConflictFileFake()
    activate(hostedFake.context)
    const hosted = mountView(hostedFake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts', tabId: 'tab-7' })
    await settle()
    expect(addressOf(hosted, 'conflict-file:w1:tab-7:math.ts')).toBeDefined()
  })

  test('deleted-file actions reserve synchronously and refuse keep when no content exists', async () => {
    const fake = makeConflictFileFake(22, conflictFile({ kind: 'deleted_by_them' }))
    const held = Promise.withResolvers<unknown>()
    fake.on('quirky.git/acceptConflictDeletion', () => held.promise)
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    const address = addressOf(mounted, 'conflict-file:w1:math.ts')
    expect(sortedActions(address)).toEqual(['accept-deletion', 'close', 'keep-file', 'next-conflict', 'previous-conflict'])

    let first: unknown
    let second: unknown
    await act(async () => {
      first = dispatch(fake, control(address, 'accept-deletion'))
      second = dispatch(fake, control(address, 'accept-deletion'))
    })
    expect(first).toEqual({ delivered: true })
    expect(second).toEqual({ delivered: false })
    expect(fake.called('quirky.git/acceptConflictDeletion')).toEqual([{
      method: 'quirky.git/acceptConflictDeletion',
      params: { worktree: 'w1', path: 'math.ts', expected: 'h-conflict' }
    }])
    await act(async () => held.resolve({ ok: true }))
    await settle()

    const unavailableFake = makeConflictFileFake(22, conflictFile({ kind: 'deleted_by_them', content: null }))
    activate(unavailableFake.context)
    const unavailable = mountView(unavailableFake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    const initialDaemonCalls = daemonCalls(unavailableFake)
    const unavailableAddress = addressOf(unavailable, 'conflict-file:w1:math.ts')
    expect(sortedActions(unavailableAddress)).not.toContain('keep-file')
    expect(await dispatchInAct(unavailableFake, control(unavailableAddress, 'keep-file'))).toEqual({ delivered: false })
    expect(daemonCalls(unavailableFake)).toEqual(initialDaemonCalls)
  })

  test('keep-file accepts one same-turn request and stages once', async () => {
    const fake = makeConflictFileFake(22, conflictFile({ kind: 'deleted_by_them' }))
    const stage = Promise.withResolvers<unknown>()
    fake.on('quirky.git/stage', () => stage.promise)
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    const address = addressOf(mounted, 'conflict-file:w1:math.ts')
    let first: unknown
    let second: unknown
    await act(async () => {
      first = dispatch(fake, control(address, 'keep-file'))
      second = dispatch(fake, control(address, 'keep-file'))
    })
    expect(first).toEqual({ delivered: true })
    expect(second).toEqual({ delivered: false })
    await settle()
    expect(fake.called('quirky.git/stage')).toHaveLength(1)
    await act(async () => stage.resolve({ ok: true }))
    await settle()
  })
  test('a stale conflict file reload reserves one refresh until it settles', async () => {
    const fake = makeConflictFileFake(22, conflictFile({ kind: 'deleted_by_them' }))
    let reads = 0
    fake.on('quirky.git/conflictFile', () => {
      reads++
      return conflictFile({ kind: 'deleted_by_them' })
    })
    fake.on('quirky.git/acceptConflictDeletion', () => {
      throw failure('disk moved', { reason: 'changed-on-disk' })
    })
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    expect(reads).toBe(1)
    const initial = addressOf(mounted, 'conflict-file:w1:math.ts')
    expect(await dispatchInAct(fake, control(initial, 'accept-deletion'))).toEqual({ delivered: true })
    await settle()
    expect(button(mounted.element, 'Reload from Disk')).not.toBeNull()
    const stale = addressOf(mounted, 'conflict-file:w1:math.ts')
    expect(sortedActions(stale)).toContain('reload')

    const heldRead = Promise.withResolvers<unknown>()
    fake.on('quirky.git/conflictFile', () => {
      reads++
      return heldRead.promise
    })
    let first: unknown
    let second: unknown
    await act(async () => {
      first = dispatch(fake, control(stale, 'reload'))
      second = dispatch(fake, control(stale, 'reload'))
    })
    expect(first).toEqual({ delivered: true })
    expect(second).toEqual({ delivered: false })
    expect(reads).toBe(2)
    await act(async () => heldRead.resolve(conflictFile({ kind: 'deleted_by_them' })))
    await settle()
    expect(button(mounted.element, 'Reload from Disk')).toBeNull()
  })

  test('conflicts reports open/close, routes Open with its path, and refuses duplicate opens', async () => {
    const fake = makeConflictsFake()
    const heldWorkspace = Promise.withResolvers<unknown>()
    fake.on('quirky.terminal/workspace', () => heldWorkspace.promise)
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'conflicts' })
    await settle()
    const address = addressOf(mounted, 'conflicts:w1')
    expect(controlsOf(mounted)).toHaveLength(1)
    expect(sortedActions(address)).toEqual(['close', 'open'])

    let first: unknown
    let second: unknown
    expect(await dispatchInAct(fake, control(address, 'open', { path: 1 as unknown as string }))).toEqual({ delivered: false })
    expect(await dispatchInAct(fake, control(address, 'open', { path: 'a.ts', extra: true }))).toEqual({ delivered: false })
    const open = control(address, 'open', { path: 'a.ts' })
    await act(async () => {
      first = dispatch(fake, open)
      second = dispatch(fake, open)
    })
    expect(first).toEqual({ delivered: true })
    expect(second).toEqual({ delivered: false })
    expect(fake.called('quirky.terminal/workspace')).toHaveLength(1)
    expect(await dispatchInAct(fake, control(address, 'open', { path: 'missing.ts' }))).toEqual({ delivered: false })
    await act(async () => heldWorkspace.resolve({ workspace: {
      id: 'w1', revision: 0, activeGroup: 'w1:group',
      root: { kind: 'group', id: 'w1:group', tabs: [], activeTab: null }
    } }))
    await settle()
    expect(fake.called('quirky.terminal/openViewTab').at(-1)?.params.input).toMatchObject({ mode: 'conflict-file', path: 'a.ts' })
  })

  test('a stale conflict read error can be retried once and a valid close is mounted', async () => {
    const fake = makeConflictsFake()
    let statusReads = 0
    fake.on('quirky.git/status', () => {
      statusReads++
      if (statusReads === 1) throw failure('not a repository')
      return fake.status
    })
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'conflicts' })
    await settle()
    expect(mounted.element.querySelector('.ui-inline-error')?.textContent).toContain('Error loading conflicts: not a repository')
    expect(button(mounted.element, 'Retry')).not.toBeNull()
    await click(button(mounted.element, 'Retry'))
    expect(statusReads).toBe(2)
    const address = addressOf(mounted, 'conflicts:w1')
    expect(sortedActions(address)).toEqual(['close', 'open'])
    await click(byLabel(mounted.element, 'Close'))
    expect(fake.called('ui.window.command.run').at(-1)?.params.args).toMatchObject({ action: 'close' })
  })
  test('the visible Open button posts its path through the mounted command', async () => {
    const fake = makeConflictsFake()
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'conflicts' })
    await settle()
    const address = addressOf(mounted, 'conflicts:w1')
    await click(button(mounted.element, 'Open'))
    expect(fake.called('ui.window.command.run').at(-1)?.params.args).toEqual(control(address, 'open', { path: 'a.ts' }))
    expect(fake.called('quirky.terminal/openViewTab').at(-1)?.params.input).toMatchObject({ mode: 'conflict-file', path: 'a.ts' })
  })

  test('Dismiss uses the mounted close action after every snapshot conflict resolves', async () => {
    const fake = makeConflictsFake()
    let reads = 0
    fake.on('quirky.git/status', () => {
      reads++
      return reads === 1 ? fake.status : statusOf([entry('a.ts', 'staged')])
    })
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'conflicts' })
    await settle()
    const address = addressOf(mounted, 'conflicts:w1')
    await click(button(mounted.element, 'Refresh'))
    await click(button(mounted.element, 'Dismiss'))
    expect(fake.called('ui.window.command.run').at(-1)?.params.args).toEqual(control(address, 'close'))
  })
})

describe('close dialog controls', () => {
  test('opens a fresh dialog generation, routes cancel/discard, and refuses a previous session', async () => {
    const fake = makeConflictFileFake()
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    const sessionA = await openDirtyDialog(mounted)
    expect(sortedActions(sessionA)).toEqual(['cancel', 'discard', 'save'])
    expect(controlsOf(mounted)).toHaveLength(2)
    expect(await bridge(fake, control(sessionA, 'cancel'))).toEqual({ result: { delivered: true } })
    expect(mounted.element.querySelector('[role="dialog"]')).toBeNull()

    const sessionB = await openDirtyDialog(mounted)
    expect(sessionB.generation).not.toBe(sessionA.generation)
    expect(await dispatchInAct(fake, control(sessionA, 'discard'))).toEqual({ delivered: false })
    let discard: unknown
    let repeatedDiscard: unknown
    await act(async () => {
      discard = dispatch(fake, control(sessionB, 'discard'))
      repeatedDiscard = dispatch(fake, control(sessionB, 'discard'))
    })
    expect(discard).toEqual({ delivered: true })
    expect(repeatedDiscard).toEqual({ delivered: false })
    await settle()
    expect(fake.views.at(-1)).toEqual({ id: s.SESSIONS_VIEW, input: { worktree: 'w1' } })
  })

  test('Save choice acknowledges before the save finishes and stays locked through delayed failure', async () => {
    const fake = makeConflictFileFake()
    const pendingSave = Promise.withResolvers<unknown>()
    fake.on('quirky.git/save', () => pendingSave.promise)
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    const address = await openDirtyDialog(mounted)
    const oldNow = Date.now
    try {
      let reply: unknown
      let request!: Promise<void>
      await act(async () => {
        request = fake.context.call('ui.window.command.run', {
          connId: 22,
          id: GIT_UI_CONTROL_COMMAND,
          args: control(address, 'save')
        }).then((value) => { reply = value })
      })
      await settle()
      expect(reply).toEqual({ result: { delivered: true } })
      expect(fake.called('quirky.git/save')).toHaveLength(1)
      const began = oldNow()
      Date.now = () => began + 30_001
      await settle()
      expect(reply).toEqual({ result: { delivered: true } })
      expect(await dispatchInAct(fake, control(address, 'cancel'))).toEqual({ delivered: false })
      expect(fake.called('quirky.git/save')).toHaveLength(1)
      await request
      await act(async () => pendingSave.reject(failure('disk full')))
      await settle()
      expect(fake.toasts.at(-1)).toEqual(['Save failed', 'disk full'])
      expect(fake.toastOptions.at(-1)).toEqual({ kind: 'error' })
    } finally {
      Date.now = oldNow
      await act(async () => pendingSave.resolve({ hash: 'saved' }))
      await settle()
    }
  })

  test('Escape routes cancel and unmount resolves the pending close choice without closing', async () => {
    const fake = makeConflictFileFake()
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    await openDirtyDialog(mounted)
    const dialog = mounted.element.querySelector<HTMLElement>('[role="dialog"]')
    if (!dialog) throw new Error('The unsaved changes dialog is not mounted')
    await press(dialog, 'Escape')
    await settle()
    expect(mounted.element.querySelector('[role="dialog"]')).toBeNull()
    expect(fake.called('ui.window.command.run').at(-1)?.params.args).toMatchObject({ action: 'cancel' })

    const pending = openDiffView()?.requestClose()
    if (!pending) throw new Error('The mounted view did not expose requestClose')
    await settle()
    expect(mounted.element.querySelector('[role="dialog"]')).not.toBeNull()
    const stale = dialogAddress(mounted)
    mounted.unmount()
    await expect(pending).resolves.toBeUndefined()
    expect(fake.views).toEqual([])
    expect(await dispatchInAct(fake, control(stale, 'cancel'))).toEqual({ delivered: false })
  })
})

describe('accepted long-running controls and failed delivery', () => {
  test('review-mark acceptance returns before a 30,001 ms operation failure', async () => {
    const fake = makeReviewFake()
    const pending = Promise.withResolvers<unknown>()
    fake.on('quirky.git/setReviewMark', () => pending.promise)
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    const address = addressOf(mounted, 'review:w1')
    const oldNow = Date.now
    try {
      let reply: unknown
      let request!: Promise<void>
      await act(async () => {
        request = fake.context.call('ui.window.command.run', {
          connId: 22, id: GIT_UI_CONTROL_COMMAND,
          args: control(address, 'mark', { path: 'a.ts', reviewed: true })
        }).then((value) => { reply = value })
      })
      await settle()
      expect(reply).toEqual({ result: { delivered: true } })
      expect(fake.called('quirky.git/setReviewMark')).toHaveLength(1)
      const began = oldNow()
      Date.now = () => began + 30_001
      await settle()
      expect(await dispatchInAct(fake, control(address, 'mark', { path: 'a.ts', reviewed: false }))).toEqual({ delivered: false })
      expect(reply).toEqual({ result: { delivered: true } })
      expect(fake.called('quirky.git/setReviewMark')).toHaveLength(1)
      await request
      await act(async () => pending.reject(failure('mark failed')))
      await settle()
      expect(fake.toasts.at(-1)).toEqual(['Could not update the review mark', 'mark failed'])
      expect(fake.toastOptions.at(-1)).toEqual({ kind: 'error' })
    } finally {
      Date.now = oldNow
      await act(async () => pending.resolve({ ok: true }))
      await settle()
    }
  })

  test('deletion acceptance returns before a 30,001 ms operation failure', async () => {
    const fake = makeConflictFileFake(22, conflictFile({ kind: 'deleted_by_them' }))
    const pending = Promise.withResolvers<unknown>()
    fake.on('quirky.git/acceptConflictDeletion', () => pending.promise)
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    const address = addressOf(mounted, 'conflict-file:w1:math.ts')
    const oldNow = Date.now
    try {
      let reply: unknown
      let request!: Promise<void>
      await act(async () => {
        request = fake.context.call('ui.window.command.run', {
          connId: 22, id: GIT_UI_CONTROL_COMMAND,
          args: control(address, 'accept-deletion')
        }).then((value) => { reply = value })
      })
      await settle()
      expect(reply).toEqual({ result: { delivered: true } })
      expect(fake.called('quirky.git/acceptConflictDeletion')).toHaveLength(1)
      expect(fake.called('quirky.git/acceptConflictDeletion')[0]?.params.expected).toBe('h-conflict')
      const began = oldNow()
      Date.now = () => began + 30_001
      await settle()
      expect(reply).toEqual({ result: { delivered: true } })
      expect(fake.called('quirky.git/acceptConflictDeletion')).toHaveLength(1)
      await request
      await act(async () => pending.reject(failure('deletion failed')))
      await settle()
      expect(fake.toasts.at(-1)).toEqual(['Accept deletion failed', 'deletion failed'])
      expect(fake.toastOptions.at(-1)).toEqual({ kind: 'error' })
    } finally {
      Date.now = oldNow
      await act(async () => pending.resolve({ ok: true }))
      await settle()
    }
  })

  test.each([
    ['refused', () => ({ result: { delivered: false } })],
    ['bridge rejection', () => { throw failure('bridge down') }],
    ['malformed reply', () => ({ result: {} })]
  ] as const)('view delivery %s matches the panel mounted refresh toast', async (_name, response) => {
    const fake = makeReviewFake()
    const panel = p.mountPanel(fake)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    await click(byLabel(panel.element, 'More source control actions'))
    const refresh = button(document.body, 'Refresh')
    expect(refresh).not.toBeNull()

    const initialDaemonCalls = daemonCalls(fake)
    const initialControlCalls = fake.called('ui.window.command.run').filter(({ params }) => params.id === GIT_UI_CONTROL_COMMAND).length
    fake.on('ui.window.command.run', response)
    const originalDom = mounted.element.innerHTML
    await click(refresh)
    const panelToast = fake.toasts.at(-1)
    const panelOptions = fake.toastOptions.at(-1)
    await click(button(mounted.element, 'Collapse all'))
    expect(fake.toasts.at(-1)).toEqual(panelToast)
    expect(fake.toastOptions.at(-1)).toEqual(panelOptions)
    expect(fake.toastOptions.slice(-2)).toEqual([{ kind: 'error' }, { kind: 'error' }])
    expect(mounted.element.innerHTML).toBe(originalDom)
    expect(daemonCalls(fake)).toEqual(initialDaemonCalls)
    expect(fake.called('ui.window.command.run').filter(({ params }) => params.id === GIT_UI_CONTROL_COMMAND)).toHaveLength(initialControlCalls + 2)
  })

  test('a delivery failure that settles after unmount does not show a toast', async () => {
    const fake = makeReviewFake()
    const pending = Promise.withResolvers<unknown>()
    activate(fake.context)
    const mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    fake.on('ui.window.command.run', () => pending.promise)
    await click(button(mounted.element, 'Collapse all'))
    expect(fake.toasts).toEqual([])
    mounted.unmount()
    await act(async () => pending.reject(failure('bridge down')))
    await settle()
    expect(fake.toasts).toEqual([])
  })
})
