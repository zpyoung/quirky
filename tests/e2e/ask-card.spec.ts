import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/quirky-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { AskRegistryEvent } from '../../src/shared/fork-ask-question-tool/ask-question-schema'

/** Mirrors `ASK_DISMISS_DELAY_MS` in the asks slice; imported as a literal because the slice pulls
 * renderer-only aliases that do not resolve in the Playwright process. */
const ASK_DISMISS_DELAY_MS = 4000

type RuntimeRpcReply<T> = { ok: true; result: T } | { ok: false; error?: { message?: string } }

async function setupAskPane(page: Page): Promise<{ paneKey: string; worktreeId: string }> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  return waitForActivePaneHookDescriptor(page)
}

/** The sidebar route the ask panel is showing, plus the tab the user's own route still points at
 * — the override must never write itself into the second one. */
async function readSidebarRoute(page: Page): Promise<{ stored: string; open: boolean }> {
  return page.evaluate(() => ({
    stored: String(window.__store?.getState().rightSidebarTab),
    open: Boolean(window.__store?.getState().rightSidebarOpen)
  }))
}

/** Directly seeds a pending, single-text-question ask onto a pane, mirroring the registry event
 * that would otherwise arrive over `ask:set` IPC. */
async function seedPendingAsk(
  page: Page,
  args: { paneKey: string; askId: string; questionId: string; question: string }
): Promise<void> {
  await page.evaluate(({ paneKey, askId, questionId, question }) => {
    window.__store?.setState((state) => ({
      pendingAsksByPaneKey: {
        ...state.pendingAsksByPaneKey,
        [paneKey]: [
          {
            askId,
            paneKey,
            status: 'pending',
            spec: { questions: [{ id: questionId, type: 'text', question }] },
            partial: {}
          }
        ]
      }
    }))
  }, args)
}

/** Pushes an event through the real `applyAskRegistryEvent` reducer. `seedPendingAsk` writes store
 * state directly, so it never arms the terminal auto-dismiss the reducer owns. */
async function applyAskEvent(page: Page, event: AskRegistryEvent): Promise<void> {
  await page.evaluate((registryEvent) => {
    window.__store?.setState({
      askWatermark: { seq: registryEvent.seq - 1, epoch: registryEvent.epoch },
      _askEventBuffer: []
    })
    window.__store?.getState().applyAskRegistryEvent(registryEvent)
  }, event)
}

function textAsk(args: {
  seq: number
  epoch: string
  askId: string
  paneKey: string
  questionId: string
  question: string
}): AskRegistryEvent {
  return {
    seq: args.seq,
    epoch: args.epoch,
    askId: args.askId,
    paneKey: args.paneKey,
    status: 'pending',
    spec: { questions: [{ id: args.questionId, type: 'text', question: args.question }] },
    partial: {}
  }
}

type RegisterAskOutcome = { askId: string } | { error: string; retryable: boolean }

/** Registers a real ask on the pane over the same RPC the CLI uses. The contextBridge API is
 * deep-frozen, so nothing here can be intercepted from the page; the card, the answer, and the
 * draft all have to travel the production path and be observed where the registry reports them.
 * Attribution needs main to have bound the pane to its live PTY, which can trail the renderer's
 * own layout on a slow host, so an `unavailable` answer is retried until the deadline. */
async function registerAsk(
  page: Page,
  args: { paneKey: string; worktreeId: string; questionId: string; question: string }
): Promise<string> {
  const requestId = `e2e-ask-${randomUUID()}`
  const deadline = Date.now() + 15_000
  let outcome: RegisterAskOutcome
  do {
    outcome = await page.evaluate(
      async ({
        paneKey,
        worktreeId,
        questionId,
        question,
        requestId
      }): Promise<RegisterAskOutcome> => {
        const call = (method: string, params: unknown) =>
          window.api.runtime.call({ method, params })
        const active = (await call('terminal.resolveActive', {})) as RuntimeRpcReply<{
          handle: string | null
        }>
        const terminalHandle = active.ok ? (active.result.handle ?? undefined) : undefined
        const response = (await call('ask.register', {
          spec: { questions: [{ id: questionId, type: 'text', question }] },
          requestId,
          paneKey,
          ...(terminalHandle ? { terminalHandle } : {}),
          worktreeId,
          cwd: '/'
        })) as RuntimeRpcReply<{ askId?: string; status?: string; reason?: string }>
        if (!response.ok) {
          return {
            error: `ask.register failed: ${response.error?.message ?? 'unknown error'}`,
            retryable: false
          }
        }
        if (response.result.askId) {
          return { askId: response.result.askId }
        }
        const terminals = await call('terminal.list', {})
        return {
          error:
            `ask.register registered nothing: ${JSON.stringify(response.result)}; ` +
            `paneKey=${paneKey}; resolveActive=${JSON.stringify(active)}; ` +
            `terminal.list=${JSON.stringify(terminals).slice(0, 2000)}`,
          retryable: true
        }
      },
      { ...args, requestId }
    )
    if ('askId' in outcome) {
      return outcome.askId
    }
    if (!outcome.retryable) {
      break
    }
    await page.waitForTimeout(250)
  } while (Date.now() < deadline)
  throw new Error(outcome.error)
}

async function cancelAsk(page: Page, askId: string): Promise<void> {
  await page.evaluate(
    (id) => window.api.runtime.call({ method: 'ask.cancel', params: { askId: id } }),
    askId
  )
}

/** The card the asks slice currently holds for `askId`, as the registry's events shaped it. */
async function readAskCard(
  page: Page,
  args: { paneKey: string; askId: string }
): Promise<{ status: string; result?: unknown } | null> {
  return page.evaluate(({ paneKey, askId }) => {
    const cards = window.__store?.getState().pendingAsksByPaneKey[paneKey] ?? []
    const card = cards.find((candidate) => candidate.askId === askId)
    return card ? { status: card.status, result: card.result } : null
  }, args)
}

/** The draft the registry has durably recorded for one question, read back over `ask.snapshot`. */
async function readPersistedDraft(
  page: Page,
  args: { askId: string; questionId: string }
): Promise<string | undefined> {
  return page.evaluate(async ({ askId, questionId }) => {
    const response = (await window.api.runtime.call({
      method: 'ask.snapshot',
      params: {}
    })) as RuntimeRpcReply<{
      asks: { askId: string; partial?: Record<string, { draft?: string }> }[]
    }>
    if (!response.ok) {
      return undefined
    }
    return response.result.asks.find((ask) => ask.askId === askId)?.partial?.[questionId]?.draft
  }, args)
}

/** Renderer-remount seam: clears the slice back to its pre-hydration shape, then replays the real
 * `hydrateAsks()` against the registry's live `ask.snapshot`. */
async function replayAskHydration(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store?.setState({ pendingAsksByPaneKey: {}, askWatermark: null, _askEventBuffer: [] })
  })
  await page.evaluate(() => window.__store?.getState().hydrateAsks())
}

test.describe('Ask card', () => {
  test('takes the right sidebar for a pending ask on the focused pane', async ({ quirkyPage }) => {
    const { paneKey } = await setupAskPane(quirkyPage)
    const askId = `e2e-ask-render-${randomUUID()}`
    const question = 'Ready to deploy the release build?'
    const before = await readSidebarRoute(quirkyPage)

    await seedPendingAsk(quirkyPage, { paneKey, askId, questionId: 'q1', question })

    await expect(quirkyPage.getByText(question)).toBeVisible({ timeout: 10_000 })
    await expect(quirkyPage.getByRole('textbox', { name: question })).toBeVisible()
    await expect(quirkyPage.getByRole('button', { name: /Questions/ })).toBeVisible()

    // The override renders the panel without touching the persisted route, so the tab the user
    // chose is still the one on record while the question is up.
    const during = await readSidebarRoute(quirkyPage)
    expect(during.open).toBe(true)
    expect(during.stored).toBe(before.stored)
    expect(during.stored).not.toBe('ask')
  })

  test('gives the sidebar back to the previous tab once the ask clears', async ({ quirkyPage }) => {
    const { paneKey } = await setupAskPane(quirkyPage)
    const epoch = `e2e-handback-${randomUUID()}`
    const askId = `e2e-ask-handback-${randomUUID()}`
    const question = 'Retire the old stack?'

    await quirkyPage.evaluate(() => window.__store?.getState().setRightSidebarTab('source-control'))
    await applyAskEvent(
      quirkyPage,
      textAsk({ seq: 1, epoch, askId, paneKey, questionId: 'q1', question })
    )
    await expect(quirkyPage.getByRole('textbox', { name: question })).toBeVisible({
      timeout: 10_000
    })

    await applyAskEvent(quirkyPage, {
      seq: 2,
      epoch,
      askId,
      paneKey,
      status: 'declined',
      partial: {},
      result: { answers: {}, skipped: ['q1'], summary: 'Declined.' }
    })

    // The rail item outlives the answer by ASK_DISMISS_DELAY_MS so the summary can be read.
    await expect(quirkyPage.getByRole('button', { name: /Questions/ })).toHaveCount(0, {
      timeout: ASK_DISMISS_DELAY_MS + 10_000
    })
    expect((await readSidebarRoute(quirkyPage)).stored).toBe('source-control')
  })

  test('answering resolves the blocked wait and collapses the card', async ({ quirkyPage }) => {
    const { paneKey, worktreeId } = await setupAskPane(quirkyPage)
    const questionId = 'q1'
    const question = 'What should the release notes say?'
    const answerText = 'Fixed the release build pipeline.'

    const askId = await registerAsk(quirkyPage, { paneKey, worktreeId, questionId, question })
    const field = quirkyPage.getByRole('textbox', { name: question })
    await expect(field).toBeVisible({ timeout: 10_000 })
    await field.fill(answerText)
    await quirkyPage.getByRole('button', { name: 'Submit' }).click()

    // The registry commits the answer and pushes the terminal event back over ask:set, so the
    // card's own result is the proof that Submit reached ask.answer with exactly what was typed.
    await expect
      .poll(async () => (await readAskCard(quirkyPage, { paneKey, askId }))?.result ?? null, {
        timeout: 10_000,
        message: 'submit did not resolve the ask through ask.answer'
      })
      .toMatchObject({
        answers: { [questionId]: { value: answerText, source: 'input' } },
        skipped: []
      })

    await expect(quirkyPage.getByText(question)).toHaveCount(0, { timeout: 10_000 })
  })

  test('restores a pending ask with its partial draft intact after a renderer remount', async ({
    quirkyPage
  }) => {
    const { paneKey, worktreeId } = await setupAskPane(quirkyPage)
    const questionId = 'q1'
    const question = 'Which branch should this ship from?'
    const draftText = 'release/1.4 pending one more fix'

    const askId = await registerAsk(quirkyPage, { paneKey, worktreeId, questionId, question })
    const field = quirkyPage.getByRole('textbox', { name: question })
    await expect(field).toBeVisible({ timeout: 10_000 })
    await field.fill(draftText)
    // The dock debounces ask.updatePartial; the replay below must run against a draft the
    // registry already holds, or it would only prove the field kept its own state.
    await expect
      .poll(() => readPersistedDraft(quirkyPage, { askId, questionId }), {
        timeout: 10_000,
        message: 'the draft never reached ask.updatePartial'
      })
      .toBe(draftText)

    await replayAskHydration(quirkyPage)

    // The regression this guards: a card that merely exists post-restart is not enough — the
    // hydrated draft must reach the field, or the user's in-progress answer is silently lost.
    await expect(field).toBeVisible({ timeout: 10_000 })
    await expect(field).toHaveValue(draftText)

    await cancelAsk(quirkyPage, askId)
  })

  test('clears a resolved card and surfaces the next queued ask on its own', async ({
    quirkyPage
  }) => {
    const { paneKey } = await setupAskPane(quirkyPage)
    const epoch = `e2e-dismiss-${randomUUID()}`
    const first = 'Should the old stack be retired?'
    const second = 'Which region goes first?'
    const askId = `e2e-ask-first-${randomUUID()}`

    await applyAskEvent(
      quirkyPage,
      textAsk({ seq: 1, epoch, askId, paneKey, questionId: 'q1', question: first })
    )
    await applyAskEvent(
      quirkyPage,
      textAsk({
        seq: 2,
        epoch,
        askId: `e2e-ask-second-${randomUUID()}`,
        paneKey,
        questionId: 'q2',
        question: second
      })
    )

    await expect(quirkyPage.getByRole('textbox', { name: first })).toBeVisible({ timeout: 10_000 })
    await expect(quirkyPage.getByRole('textbox', { name: second })).toHaveCount(0)

    await applyAskEvent(quirkyPage, {
      seq: 3,
      epoch,
      askId,
      paneKey,
      status: 'declined',
      partial: {},
      result: { answers: {}, skipped: ['q1'], summary: 'Declined.' }
    })

    await expect(quirkyPage.getByText('Declined.')).toBeVisible({ timeout: 10_000 })
    // The regression this guards: the resolved card used to sit at the head forever, so the
    // already-queued second ask was never shown.
    await expect(quirkyPage.getByRole('textbox', { name: second })).toBeVisible({
      timeout: ASK_DISMISS_DELAY_MS + 10_000
    })
    await expect(quirkyPage.getByText('Declined.')).toHaveCount(0)
  })

  test('scrolls a long card and keeps Submit pinned inside the panel', async ({ quirkyPage }) => {
    const { paneKey } = await setupAskPane(quirkyPage)
    const askId = `e2e-ask-tall-${randomUUID()}`

    await quirkyPage.evaluate(
      ({ pane, id }) => {
        window.__store?.setState((state) => ({
          pendingAsksByPaneKey: {
            ...state.pendingAsksByPaneKey,
            [pane]: [
              {
                askId: id,
                paneKey: pane,
                status: 'pending',
                spec: {
                  // Enough to overflow a full-height sidebar on any display this runs on — ten
                  // fit without scrolling now that the card is not capped at 28rem.
                  questions: Array.from({ length: 40 }, (_, index) => ({
                    id: `q${index}`,
                    type: 'text' as const,
                    question: `Tall card question ${index}?`
                  }))
                },
                partial: {}
              }
            ]
          }
        }))
      },
      { pane: paneKey, id: askId }
    )

    await expect(quirkyPage.getByRole('textbox', { name: 'Tall card question 0?' })).toBeVisible({
      timeout: 10_000
    })
    await expect(quirkyPage.getByRole('button', { name: 'Submit' })).toBeVisible()

    const metrics = await quirkyPage.evaluate(() => {
      const submit = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Submit'
      )
      // Walk up to the card root rather than matching a utility class, so the assertion does
      // not re-break the next time the shell's classes change.
      let node = submit?.parentElement ?? null
      while (node && !node.querySelector('.overflow-y-auto')) {
        node = node.parentElement
      }
      const body = node?.querySelector<HTMLElement>('.overflow-y-auto')
      if (!body || !submit) {
        return null
      }
      return {
        scrollHeight: body.scrollHeight,
        clientHeight: body.clientHeight,
        submitBottom: submit.getBoundingClientRect().bottom,
        viewportHeight: window.innerHeight
      }
    })

    expect(metrics).not.toBeNull()
    // The questions scroll…
    expect(metrics!.scrollHeight).toBeGreaterThan(metrics!.clientHeight)
    // …and the footer stays on screen rather than being pushed out of the panel with them.
    expect(metrics!.submitBottom).toBeLessThanOrEqual(metrics!.viewportHeight)
  })
})
