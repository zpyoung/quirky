import { expect, test } from 'bun:test'
import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createProcessScope } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'
import { CLI_FILES_LIMITS } from './cli-files-limits'

const root = resolve(import.meta.dir, '../..')
function sourceOutputs(): unknown[] {
  const entries: unknown[] = []
  const visit = (path: string) => {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) { entries.push([path, 'absent']); return }
    entries.push([path, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
      stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'directory'])
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name))
  }
  visit(join(root, 'packages/ui/dist'))
  for (const plugin of readdirSync(join(root, 'plugins')).sort()) {
    if (statSync(join(root, 'plugins', plugin)).isDirectory()) visit(join(root, 'plugins', plugin, 'dist'))
  }
  return entries
}

test('the real two-window CLI rehearsal observes file placement and cleans its owned processes', async () => {
  const before = sourceOutputs()
  const scope = createProcessScope()
  const env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot: root })
  mkdirSync(env.TMPDIR!, { recursive: true })
  const sentinel = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { env, stdout: 'ignore', stderr: 'ignore' })
  const child = scope.spawn([process.execPath, 'scripts/parity/cli-files.ts', '--json'], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  // real subprocess watchdogs must fire even when the daemon or browser stops responding.
  const watchdog = setTimeout(() => scope.killNow(), CLI_FILES_LIMITS.watchdogMs)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    console.info('cli-files timing:')
    for (const line of stderr.split('\n').filter(line =>
      line.startsWith('[cli-files] ') && / observed in | failed after | finished in | failed: /.test(line)).slice(-40)) {
      let bytes = Buffer.from(line).subarray(0, 512)
      while (bytes.length && !isUtf8(bytes)) bytes = bytes.subarray(0, bytes.length - 1)
      console.info(bytes.toString())
    }
    const report = JSON.parse(stdout)
    console.info(JSON.stringify({
      elapsedMs: report.elapsedMs,
      buildElapsedMs: report.buildElapsedMs,
      startup: {
        phase: report.startup?.phase,
        elapsedMs: report.startup?.elapsedMs,
        buildElapsedMs: report.startup?.buildElapsedMs,
        rendererElapsedMs: report.startup?.rendererElapsedMs,
        renderer: report.startup?.renderer.slice(-64)
      },
      cleanup: {
        ok: report.cleanup.ok,
        trackedIdentities: report.cleanup.evidence?.trackedIdentities?.length,
        homeRemoved: report.cleanup.evidence?.homeRemoved,
        processIdentitiesGone: report.cleanup.evidence?.processIdentitiesGone,
        sentinelAlive: report.cleanup.evidence?.sentinelAlive
      },
      error: report.error,
      observations: report.observations.map((entry: { id: string; status: string; evidence?: { elapsedMs: number } }) =>
        ({ id: entry.id, status: entry.status, elapsedMs: entry.evidence?.elapsedMs })),
      rows: report.rows.map((row: { id: string; status: string; executed: boolean }) =>
        ({ id: row.id, status: row.status, executed: row.executed })),
      receiptCount: report.receipts.length,
      observationElapsedMs: Object.fromEntries(report.observations.map((entry: { id: string; evidence?: { elapsedMs: number } }) => [entry.id, entry.evidence?.elapsedMs]))
    }))
    expect(code, stderr + '\n' + stdout).toBe(0)
    expect(report.parityComplete).toBe(true)
    expect(report).toMatchObject({ schemaVersion: 1, scope: 'goal-11-cli-files', ok: true, cleanup: { ok: true } })
    expect(report.startup.phase).toBe('ready')
    expect(report.startup.buildElapsedMs).toBe(report.buildElapsedMs)
    expect(report.startup.assets).toEqual({ uiDir: '<cli-home>/ui-dist', pluginsDir: '<cli-home>/builtin-plugins' })
    const ready = report.startup.renderer.filter((entry: { stage: string }) => entry.stage === 'ready')
    expect(ready.map((entry: { index: number; connId: number; worktree: string }) =>
      [entry.index, entry.connId, entry.worktree])).toEqual(
      report.observations[0].before.map((entry: { connId: number; windowWorktree: string }, index: number) =>
        [index, entry.connId, entry.windowWorktree]))
    expect(ready).toHaveLength(2)
    expect(new Set(ready.map((entry: { connId: number }) => entry.connId)).size).toBe(2)
    const renderer = report.startup.renderer as Array<{
      stage: string; elapsedMs: number; index?: number; connId?: number; worktree?: string; browserPid?: number
    }>
    const shellReady = renderer.filter(entry => entry.stage === 'shell-ready')
    expect(shellReady).toHaveLength(2)
    expect(renderer.filter(entry => entry.stage === 'shell')).toHaveLength(2)
    const setup = renderer.findIndex(entry => entry.stage === 'changes')
    for (const identity of ready) {
      const completion = shellReady.find(entry => entry.index === identity.index)!
      expect(completion).toMatchObject({
        index: identity.index, connId: identity.connId, worktree: identity.worktree, browserPid: identity.browserPid
      })
      const start = renderer.findIndex(entry => entry.stage === 'shell' && entry.index === identity.index)
      const end = renderer.indexOf(completion)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      expect(end).toBeLessThan(setup)
      expect(renderer.findIndex(entry => entry.stage === 'worktree')).toBeGreaterThan(end)
      expect(Number.isFinite(completion.elapsedMs)).toBe(true)
      expect(completion.elapsedMs).toBeGreaterThanOrEqual(renderer[start]!.elapsedMs)
      expect(completion.elapsedMs).toBeLessThan(30_000)
      expect(identity.elapsedMs).toBeLessThan(30_000)
    }
    expect(report.cleanup.evidence.homeRemoved).toBe(true)
    expect(report.error).toBeUndefined()
    expect(report.timing.cliCalls).toBe(report.receipts.length)
    expect(stderr).toMatch(/^\[cli-files\] setup finished in /m)
    expect(stderr.match(/^\[cli-files\] .+ observed in /gm)).toHaveLength(13)
    expect(stderr).toMatch(/^\[cli-files\] teardown finished in /m)
    for (const key of ['setupMs', 'observationsMs', 'teardownMs', 'cliCalls', 'cliChildMs', 'harnessMs', 'domWaitMs']) {
      expect(Number.isInteger(report.timing[key])).toBe(true)
      expect(report.timing[key]).toBeGreaterThanOrEqual(0)
    }
    expect(report.timing.cliChildMs).toBe(report.receipts.reduce(
      (sum: number, receipt: { elapsedMs: number }) => sum + receipt.elapsedMs, 0))
    expect(report.rows.map((row: { id: string }) => row.id)).toEqual(['file-diff', 'file-open', 'file-open-changed', 'file-open-render'])
    const expectedObservations: Record<string, string[]> = {
      'file-diff': [
        'files-review-diff', 'files-review-reuse', 'files-window-routing', 'files-window-refusals',
        'files-review-focus-window', 'files-review-background', 'files-review-source'
      ],
      'file-open': ['files-editor-local', 'files-editor-other-worktree', 'files-editor-literal-path', 'files-editor-window-focus'],
      'file-open-changed': [
        'files-review-changed', 'files-window-routing', 'files-window-refusals', 'files-review-focus-window', 'files-changed-modes'
      ],
      'file-open-render': [
        'files-editor-local', 'files-editor-other-worktree', 'files-editor-literal-path', 'files-editor-window-focus', 'files-window-refusals'
      ]
    }
    const expectedDifferences: Record<string, string[]> = {
      'file-diff': [
        'Quirky Review is one combined tab per worktree, not one diff tab per file.',
        'Review focuses by default; Orca opens the diff in the background.',
        'Exact window routing uses ui.window.command.run --conn-id rather than a command flag.',
        'Background reveal or scope applies in the target renderer when Review is next shown.',
        'Review source selects staged or unstaged; omission shows the whole review, not Orca’s unstaged default.'
      ],
      'file-open': ['Without --window, --focus selects the tab in its worktree workspace and moves no window.'],
      'file-open-changed': [
        'Quirky Review is one combined tab per worktree rather than one tab per changed file.',
        'Review focuses by default; Orca opens in the background.',
        'Edit and both open at most 50 files and refuse capped status; deleted files are skipped.'
      ],
      'file-open-render': [
        '--window routes focused editor open to the chosen Quirky renderer; without it, focus selects only the workspace tab.',
        'Headless document focus is not native macOS window raising.'
      ]
    }
    for (const row of report.rows) {
      expect(row).toMatchObject({ disposition: 'covered', status: 'observed', executed: true })
      expect(row.observations).toEqual(expectedObservations[row.id])
      expect(row.differences).toEqual(expectedDifferences[row.id])
    }
    expect(report.observations.map((entry: { id: string }) => entry.id).sort()).toEqual([
      'files-editor-local', 'files-editor-other-worktree', 'files-editor-literal-path', 'files-editor-window-focus',
      'files-window-refusals', 'files-review-diff', 'files-review-reuse', 'files-window-routing',
      'files-review-focus-window', 'files-review-background', 'files-review-source', 'files-review-changed', 'files-changed-modes'
    ].sort())
    const receiptById = new Map<string, { id: string; elapsedMs: number }>(
      report.receipts.map((receipt: { id: string; elapsedMs: number }) => [receipt.id, receipt]))
    for (const observation of report.observations) {
      expect(observation.status, JSON.stringify(observation.error)).toBe('observed')
      expect(Number.isFinite(observation.evidence.elapsedMs)).toBe(true)
      expect(observation.evidence.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(observation.receiptIds.length).toBeGreaterThan(0)
      for (const receiptId of observation.receiptIds) expect(receiptById.has(receiptId)).toBe(true)
      const timing = observation.evidence.timing
      for (const key of ['cliCalls', 'cliChildMs', 'harnessMs', 'domWaitMs']) {
        expect(Number.isInteger(timing[key])).toBe(true)
        expect(timing[key]).toBeGreaterThanOrEqual(0)
      }
      expect(timing.cliCalls).toBe(observation.receiptIds.length)
      expect(timing.cliChildMs).toBe(observation.receiptIds.reduce(
        (sum: number, id: string) => sum + receiptById.get(id)!.elapsedMs, 0))
      expect(observation.before).toHaveLength(2)
      expect(observation.after).toHaveLength(2)
      for (const sample of [...observation.before, ...observation.after]) {
        expect(sample.connId).toBeGreaterThan(0)
        expect(sample.workspaceId).toBe(sample.windowWorktree)
        expect(sample.windowViewId).toBe('view:quirky.session/worktree')
      }
    }
    const observationFor = (id: string) => report.observations.find((entry: { id: string }) => entry.id === id)
    const receiptFor = (id: string) => report.receipts.find((entry: { id: string }) => entry.id === id)
    const replyFor = (id: string) => receiptFor(id)?.evidence?.result?.result

    const windowFocusObservation = observationFor('files-editor-window-focus')
    const windowFocus = windowFocusObservation.evidence.windowFocus
    const focusOpen = receiptFor(windowFocus.focus.receiptId).evidence.result
    const reusedOpen = receiptFor(windowFocus.reuse.receiptId).evidence.result
    const backgroundOpen = receiptFor(windowFocus.background.receiptId).evidence.result
    expect(typeof focusOpen.id).toBe('string')
    expect(focusOpen).toMatchObject({
      worktreeId: windowFocusObservation.evidence.request.worktreeId,
      path: windowFocusObservation.evidence.request.absolutePath,
      openedTabId: windowFocus.tabId
    })
    expect(windowFocus.focus.before.public[0].windowState.layout.worktree)
      .not.toBe(windowFocusObservation.evidence.request.worktreeId)
    expect(windowFocus.focus.after.public[0].windowState.layout.worktree).toBe(windowFocusObservation.evidence.request.worktreeId)
    expect(windowFocus.focus.after.public[1].windowState.layout.worktree).toBe(windowFocus.focus.before.public[1].windowState.layout.worktree)
    expect(windowFocus.focus.after.dom[0]).toMatchObject({
      renderedTabId: windowFocus.tabId,
      path: windowFocusObservation.evidence.request.absolutePath,
      lines: ['first', 'second λ', ''],
      caret: { line: 2, column: 3 },
      activeElementHostedTabId: windowFocus.tabId,
      activeElementIsSource: true
    })
    expect(windowFocus.focus.after.dom[1]).toEqual(windowFocus.focus.before.dom[1])
    expect(reusedOpen.id).toBe(focusOpen.id)
    expect(reusedOpen.openedTabId).toBe(windowFocus.tabId)
    expect(windowFocus.reuse.after.public[0].editor.tabs.filter((tab: { bufferId: string }) => tab.bufferId === focusOpen.id))
      .toHaveLength(1)
    expect(windowFocus.reuse.after.dom[0].caret).toEqual({ line: 1, column: 1 })
    expect(backgroundOpen.openedTabId).not.toBe(windowFocus.tabId)
    expect(windowFocus.background.after.public.map((window: { windowState: { layout: unknown } }) => window.windowState.layout))
      .toEqual(windowFocus.background.before.public.map((window: { windowState: { layout: unknown } }) => window.windowState.layout))
    expect(windowFocus.background.after.dom[0]).toEqual(windowFocus.background.before.dom[0])

    const refusalObservation = observationFor('files-window-refusals')
    const refusals = refusalObservation.evidence.refusals
    expect(refusals.cases.map((entry: { receiptId: string }) => {
      const receipt = receiptFor(entry.receiptId)
      return [receipt.exitCode, receipt.evidence.result.error.code, receipt.evidence.result.error.message]
    })).toEqual([
      [1, 'conflict', 'UI window connection 999 is not open'],
      [2, 'usage', expect.any(String)],
      [1, 'invalid-params', 'window cannot be combined with focus: false'],
      [1, 'conflict', 'UI window connection 999 is not open'],
      [1, 'conflict', `UI window connection ${refusals.disconnected.connId} is not open`],
      [1, 'conflict', `UI window connection ${refusals.disconnected.connId} is not open`]
    ])
    expect(refusals.disconnected.connId).not.toBe(refusalObservation.before[0].connId)
    expect(refusals.disconnected.connId).not.toBe(refusalObservation.before[1].connId)
    expect(refusals.disconnected.listedWhenCommandsRan).toBe(false)

    const focusReviewObservation = observationFor('files-review-focus-window')
    const focusReview = focusReviewObservation.evidence.focusWindow
    const openedReview = replyFor(focusReview.openDiffReceiptId)
    expect(openedReview).toMatchObject({
      worktree: focusReview.worktreeId,
      tabId: focusReview.tabId,
      created: false,
      focused: true,
      source: null,
      reveal: 'src/app.ts',
      statusComplete: null
    })
    expect(focusReview.diff.after.public[0].windowState.layout.worktree).toBe(focusReview.worktreeId)
    expect(focusReview.diff.after.public[1].windowState.layout.worktree)
      .toBe(focusReview.diff.before.public[1].windowState.layout.worktree)
    expect(focusReview.diff.after.dom[0].reviewCards.find((card: { path: string }) => card.path === 'src/app.ts'))
      .toMatchObject({ active: true, expanded: true, loaded: true })
    expect(replyFor(focusReview.openChangesReceiptId)).toMatchObject({
      worktree: focusReview.worktreeId,
      mode: 'diff',
      source: null,
      focused: true,
      review: { tabId: focusReview.tabId, created: false, focused: true, source: null, reveal: null, statusComplete: null },
      opened: [],
      skipped: []
    })

    const backgroundReviewObservation = observationFor('files-review-background')
    const backgroundReview = backgroundReviewObservation.evidence.backgroundReview
    expect(replyFor(backgroundReview.coldReceiptId)).toMatchObject({
      worktree: backgroundReview.worktreeId,
      tabId: backgroundReview.tabId,
      created: true,
      focused: false,
      source: null,
      reveal: 'src/app.ts'
    })
    expect(replyFor(backgroundReview.mountedReceiptId)).toMatchObject({
      tabId: backgroundReview.tabId,
      created: false,
      focused: false,
      reveal: 'docs/review-notes.md'
    })
    expect(backgroundReview.cold.after.activeTab).toBe(backgroundReview.sentinelTabId)
    expect(backgroundReview.cold.after.dom.every((dom: { reviewTabMounted: boolean }) => !dom.reviewTabMounted)).toBe(true)
    expect(backgroundReview.mounted.after.dom[1].reviewCards.find((card: { path: string }) => card.path === 'src/app.ts'))
      .toMatchObject({ active: true })
    expect(backgroundReview.mounted.scrollTopAfter).toBe(backgroundReview.mounted.scrollTopBefore)
    expect(backgroundReview.mounted.inputAfter).toEqual(backgroundReview.mounted.inputBefore)
    expect(backgroundReview.mounted.afterShow.dom[1].reviewCards.find((card: { path: string }) => card.path === 'docs/review-notes.md'))
      .toMatchObject({ active: true, expanded: true, loaded: true })
    expect(backgroundReview.mounted.afterShow.dom[1].reviewCards
      .filter((card: { active: boolean }) => card.active).map((card: { path: string }) => card.path))
      .toEqual(['docs/review-notes.md'])

    const sourceObservation = observationFor('files-review-source')
    const source = sourceObservation.evidence.sourceReview
    expect(source.scopes.staged.cardPaths).toEqual(source.status.stagedPaths)
    expect(source.scopes.unstaged.cardPaths).toEqual(source.status.unstagedPaths)
    const stagedReadme = source.scopes.staged.dom[0].reviewCards.find((card: { path: string }) => card.path === 'README.md')
    const unstagedReadme = source.scopes.unstaged.dom[0].reviewCards.find((card: { path: string }) => card.path === 'README.md')
    const wholeReadme = source.scopes.whole.dom[0].reviewCards.find((card: { path: string }) => card.path === 'README.md')
    expect(stagedReadme.originalLines).toEqual(source.readme.base.split('\n'))
    expect(stagedReadme.modifiedLines).toEqual(source.readme.index.split('\n'))
    expect(unstagedReadme.originalLines).toEqual(source.readme.index.split('\n'))
    expect(unstagedReadme.modifiedLines).toEqual(source.readme.working.split('\n'))
    expect(wholeReadme.modifiedLines).toEqual(source.readme.working.split('\n'))
    expect(wholeReadme.originalLines.join('\n')).not.toContain('scope index λ')
    expect(wholeReadme.originalLines.join('\n')).not.toContain('scope working λ')
    expect(new Set([source.readme.base, source.readme.index, source.readme.working]).size).toBe(3)
    expect(source.scopes.staged.chip).toBe('Staged changes')
    expect(source.scopes.unstaged.chip).toBe('Unstaged changes')
    expect(source.scopes.whole.chip).toBeNull()
    expect(source.refusal.code).toBe('conflict')

    const modesObservation = observationFor('files-changed-modes')
    const modes = modesObservation.evidence.changedModes
    const editResult = replyFor(modes.edit.receiptId)
    const bothResult = replyFor(modes.both.receiptId)
    const unstagedResult = replyFor(modes.unstagedEdit.receiptId)
    expect(editResult).toMatchObject({
      worktree: modes.worktreeId,
      mode: 'edit',
      focused: false,
      review: null,
      skipped: [{ path: 'README.md', reason: 'deleted' }]
    })
    expect(editResult.opened.map((entry: { path: string }) => entry.path)).toEqual(modes.expectedEditPaths)
    expect(editResult.opened.find((entry: { path: string; tabId: string }) => entry.path === 'src/app.ts').tabId).toBe(focusOpen.openedTabId)
    expect(modes.edit.after.public[1].workspace.workspace.root.activeTab).toBe(modes.sentinelTabId)
    expect(modes.edit.after.dom[1]).toEqual(modes.edit.before.dom[1])
    expect(bothResult.opened).toEqual(editResult.opened)
    expect(bothResult.skipped).toEqual(editResult.skipped)
    expect(bothResult).toMatchObject({
      mode: 'both',
      focused: true,
      review: { tabId: source.tabId, created: false, focused: true }
    })
    expect(unstagedResult.opened.map((entry: { path: string }) => entry.path)).toEqual(modes.expectedUnstagedPaths)
    expect(unstagedResult.skipped).toContainEqual({ path: 'README.md', reason: 'deleted' })
    expect(unstagedResult.opened.find((entry: { path: string; tabId: string }) => entry.path === 'src/app.ts').tabId).toBe(focusOpen.openedTabId)
    expect(modes.unstagedEdit.after.dom[0].path).toBe(modes.unstagedEdit.firstOpenedAbsolutePath)

    for (const [id, lines] of [
      ['files-editor-local', ['first A', 'second A', '']],
      ['files-editor-other-worktree', ['first', 'second λ', '']],
      ['files-editor-literal-path', ['literal path', '']]
    ] as const) {
      const observation = report.observations.find((entry: { id: string }) => entry.id === id)
      const request = observation.evidence.request
      const destination = observation.after.findIndex((sample: { windowWorktree: string }) => sample.windowWorktree === request.worktreeId)
      expect(destination).toBeGreaterThanOrEqual(0)
      const snapshot = observation.after[destination]
      const dom = observation.evidence.dom.after[destination]
      expect(dom.lines).toEqual([...lines])
      expect(snapshot.path).toBe(request.absolutePath)
      expect(snapshot.renderedTabId).toBe(snapshot.selectedTabId)
      expect(snapshot.activeElement.inDocument).toBe(true)
      expect(snapshot.caret).toEqual(id === 'files-editor-literal-path' ? { line: 1, column: 1 } : { line: 2, column: 3 })
      if (id !== 'files-editor-literal-path') {
        expect(observation.evidence.background.dom.map((sample: { selectedTabId: string }) => sample.selectedTabId))
          .toEqual(observation.before.map((sample: { selectedTabId: string }) => sample.selectedTabId))
        expect(observation.after.map((sample: { windowWorktree: string }) => sample.windowWorktree))
          .toEqual(observation.before.map((sample: { windowWorktree: string }) => sample.windowWorktree))
      }
    }
    for (const id of ['files-review-diff', 'files-review-reuse', 'files-review-changed']) {
      const observation = report.observations.find((entry: { id: string }) => entry.id === id)
      expect(observation.after[0].windowWorktree).toBe(observation.after[1].windowWorktree)
      expect(observation.after[0].selectedTabId).toBe(observation.after[1].selectedTabId)
      expect(observation.after[0].renderedTabId).toBe(observation.after[0].selectedTabId)
      const cards = observation.evidence.dom.after[0].reviewCards as Array<{ path: string; expanded: boolean; loaded: boolean; text: string }>
      const revealedPath = id === 'files-review-reuse' ? 'docs/review-notes.md' : 'src/app.ts'
      expect(cards.find(card => card.path === revealedPath)).toMatchObject({ expanded: true, loaded: true })
      if (id !== 'files-review-reuse') expect(cards.find(card => card.path === 'src/app.ts')?.text).toContain('second λ')
      if (id === 'files-review-changed') expect(cards.map(card => card.path)).toEqual(expect.arrayContaining(['src/app.ts', 'docs/review-notes.md']))
    }
    const routing = report.observations.find((entry: { id: string }) => entry.id === 'files-window-routing')
    expect(routing.after.map((sample: { windowWorktree: string; selectedTabId: string | null }) => [sample.windowWorktree, sample.selectedTabId]))
      .toEqual(routing.before.map((sample: { windowWorktree: string; selectedTabId: string | null }) => [sample.windowWorktree, sample.selectedTabId]))
    const receipts = report.receipts as Array<{ id: string; argv: string[]; exitCode: number; evidence: unknown }>
    expect(new Set(receipts.map(receipt => receipt.id)).size).toBe(receipts.length)
    for (const receipt of receipts) {
      expect(receipt.argv.slice(-3)).toEqual(['--runtime', 'local', '--json'])
      expect(receipt.evidence).toBeTruthy()
    }
    const refusal = receipts.find(receipt => receipt.argv[0] === 'ui' && receipt.argv[1] === 'run')!
    expect(refusal.exitCode).toBe(1)
    expect(JSON.stringify(refusal.evidence)).toContain('multiple Quirky windows are open; specify connId')
    expect(receipts.some(receipt => receipt.argv.includes('ui.window.command.run') && receipt.exitCode === 0)).toBe(true)
    const literal = receipts.find(receipt => receipt.argv[0] === 'editor' && receipt.argv[1] === 'open' && receipt.argv[2]?.includes('$(touch cli-injected)'))!
    expect(literal.argv[2]).toBe("cli-parity/open '$(touch cli-injected); λ.txt")
    expect(report.elapsedMs).toBeGreaterThan(0)
    expect(report.buildElapsedMs).toBeGreaterThan(0)
    expect(report.cleanup.evidence.processIdentitiesGone).toBe(true)
    expect(report.cleanup.evidence.sentinelAlive).toBe(true)
    expect(report.cleanup.evidence.trackedIdentities.some((identity: { command: string }) => identity.command.includes('daemon/src/main.ts'))).toBe(true)
    expect(report.cleanup.evidence.trackedIdentities.some((identity: { command: string }) => /chrome|chromium/i.test(identity.command))).toBe(true)
    for (const identity of report.cleanup.evidence.trackedIdentities) {
      expect(identity, identity.command).toHaveProperty('gone', true)
    }
    expect(report.cleanup.evidence.temporaryPageIdentities).toHaveLength(1)
    expect(report.cleanup.evidence.temporaryPageIdentities[0]).toMatchObject({
      connId: refusals.disconnected.connId,
      contextClosed: true,
      pageClosed: true,
      connectionGone: true
    })
    expect(report.guards).toMatchObject({ denied: [], egress: ['https://cli-parity-guard.invalid/self-test'], injected: false })
    expect(stdout).not.toMatch(/#token=|hookToken|runtimeToken/)
    expect(existsSync(resolve(root, 'cli-injected'))).toBe(false)
    expect(sentinel.exitCode).toBeNull()
  } finally {
    clearTimeout(watchdog)
    try {
      sentinel.kill('SIGKILL')
      await sentinel.exited
      await scope.cleanup()
    } finally {
      expect(sourceOutputs()).toEqual(before)
    }
  }
}, CLI_FILES_LIMITS.testMs)

