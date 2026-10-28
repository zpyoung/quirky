import { randomUUID } from 'node:crypto'
import type { PluginContext } from '@quirky/protocol'
import type { DesignAnnotation, DesignGuestAction, DesignPayload, DesignRead, DesignRect, DesignScreenshot, DesignTarget, DesignTargets } from '../design-contract'
import { clampAnnotations, clampPayload, MAX_SCREENSHOT_BYTES } from './payload'
import { formatBrowserAnnotationsAsMarkdown, formatGrabPayloadAsText } from './format'
import { guestProgram } from './guest'
import { BrowserFault, fault } from '../runtime/errors'
import type { PageExecution, RuntimeBinding } from '../runtime/driver'
import type { BrowserRuntime } from '../runtime/driver'
import type { BrowserPage } from '../profiles/store'
import type { PaneTab } from '../pane-contract'
import type { DesignRequests } from '../design-contract'

const OPERATION_TIMEOUT_MS = 120_000
const OPERATION_TOMBSTONE_MS = 120_000
const MAX_TOMBSTONES = 256
const GUEST_CALL_TIMEOUT_MS = 5_000
const CAPTURE_TIMEOUT_MS = 15_000
const NEW_AGENT_SETTLE_TIMEOUT_MS = 90_000
const NEW_AGENT_POLL_MS = 100
const OWNER_ANNOTATION_ATTRIBUTE = 'data-orca-browser-annotation-overlay'
const CAPTURE_MARKER_ATTRIBUTE = 'data-quirky-design-capture'
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const SECRET_MARKERS = [
  'access_token', 'auth_token', 'api_key', 'apikey', 'client_secret', 'oauth_state', 'x-amz-',
  'session_id', 'sessionid', 'csrf', 'secret', 'password', 'passwd'
]

type PanePageResolver = (pageId: string) => BrowserPage
type ActiveOperation = {
  opId: string
  pane: string
  pageId: string
  worktreeId: string
  profileId: string
  expiresAt: number
  binding: RuntimeBinding
  mainFrameId?: string
  mainFrameLoaderId?: string
  mainFrameUrl?: string
  mode: 'grab' | 'annotate'
  hoverPayload?: DesignPayload
  selectionPayload?: DesignPayload
  subscriptions: (() => void)[]
  timer: ReturnType<typeof setTimeout>
}
type RetiredOperation = { pane: string; status: 'cancelled' | 'expired'; expiresAt: number }
type AnnotationSnapshot = { key: string; visibility: string; priority: string }
type SessionRecord = {
  id: string
  kind?: string
  agent: string
  worktreeId: string | null
  title?: string
  name?: string | null
  status: string
  lastActivityAt?: number
  agentStatus?: { display?: string; label?: string; state?: string } | null
  promptDelivery?: string | null
}
type TerminalRecord = { sessionId: string; state: string; worktreeId: string | null }
type AgentRecord = { id: string; label: string; installed: boolean; enabled: boolean }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw fault('invalid_argument', `${name} must be a non-empty string`)
  return value
}

function isSecret(value: string): boolean {
  const lower = value.toLowerCase()
  return SECRET_MARKERS.some((marker) => lower.includes(marker))
}

function targetText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  if (isSecret(value)) return '[redacted]'
  return value.replace(/\s+/g, ' ').trim().slice(0, 300)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sanitizeTerminalControls(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n')
  let result = ''
  for (const character of normalized) {
    const code = character.charCodeAt(0)
    if (code === 9) {
      result += '  '
      continue
    }
    if ((code < 32 && code !== 10) || (code >= 127 && code <= 159)) continue
    result += character
  }
  return result
}
function base64ByteLength(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)) return null
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return value.length * 3 / 4 - padding
}

function base64ByteAt(value: string, byteIndex: number): number {
  const group = Math.floor(byteIndex / 3) * 4
  const position = byteIndex % 3
  const a = BASE64.indexOf(value[group] ?? '')
  const b = BASE64.indexOf(value[group + 1] ?? '')
  const c = BASE64.indexOf(value[group + 2] ?? '')
  const d = BASE64.indexOf(value[group + 3] ?? '')
  if (a < 0 || b < 0 || c < 0 || d < 0) return -1
  if (position === 0) return (a << 2) | (b >> 4)
  if (position === 1) return ((b & 15) << 4) | (c >> 2)
  return ((c & 3) << 6) | d
}

function pngDimensions(base64: string): { width: number; height: number } | null {
  if (!base64.startsWith('iVBORw0KGgoAAAANSUhEUg')) return null
  let width = 0
  let height = 0
  for (let index = 0; index < 4; index++) {
    const widthByte = base64ByteAt(base64, 16 + index)
    const heightByte = base64ByteAt(base64, 20 + index)
    if (widthByte < 0 || heightByte < 0) return null
    width = width * 256 + widthByte
    height = height * 256 + heightByte
  }
  return width > 0 && height > 0 ? { width, height } : null
}

function stalePageError(error: unknown): boolean {
  return error instanceof BrowserFault && (error.reason === 'browser_tab_closed' || error.reason === 'browser_tab_changed' || error.reason === 'browser_no_tab' || error.reason === 'browser_tab_not_found')
}

function sameBinding(expected: RuntimeBinding, actual: RuntimeBinding): boolean {
  return expected.browserEpoch === actual.browserEpoch && expected.pageGeneration === actual.pageGeneration &&
    expected.targetId === actual.targetId && expected.sessionId === actual.sessionId && expected.tabId === actual.tabId
}

function finiteRect(value: unknown): DesignRect {
  const source = record(value)
  if (!source || !isFiniteNumber(source.x) || !isFiniteNumber(source.y) || !isFiniteNumber(source.width) || !isFiniteNumber(source.height)) {
    throw fault('invalid_argument', 'capture rect must contain finite x, y, width, and height')
  }
  if (source.width < 0 || source.height < 0) throw fault('invalid_argument', 'capture rect width and height must not be negative')
  return { x: source.x, y: source.y, width: source.width, height: source.height }
}

function guestValue(response: unknown): unknown {
  const outer = record(response)
  if (!outer || outer.exceptionDetails !== undefined) throw fault('browser_eval_error', 'browser design guest evaluation failed')
  const result = record(outer.result)
  if (!result || !Object.hasOwn(result, 'value')) throw fault('browser_tab_changed', 'browser design guest returned no result')
  return result.value
}

export class DesignService {
  private readonly operations = new Map<string, ActiveOperation>()
  private readonly operationByPage = new Map<string, string>()
  private readonly operationByPane = new Map<string, string>()
  private readonly retired = new Map<string, RetiredOperation>()

  constructor(
    private readonly context: PluginContext,
    private readonly runtime: Pick<BrowserRuntime, 'withPage'>,
    private readonly listPanes: () => PaneTab[],
    private readonly getPage: PanePageResolver,
    private readonly now: () => number = Date.now
  ) {}

  async deactivate(): Promise<void> {
    await this.cancelOperations([...this.operations.values()])
  }

  async designArm(request: DesignRequests['designArm']): Promise<{ opId: string }> {
    const paneId = requiredString(request?.pane, 'pane')
    if (request.mode !== 'grab' && request.mode !== 'annotate') throw fault('invalid_argument', 'design mode must be grab or annotate')
    const { tab, page } = this.requireWatchPane(paneId)
    const previousIds = new Set([this.operationByPane.get(paneId), this.operationByPage.get(page.browserPageId)])
    for (const previousId of previousIds) {
      const previous = previousId ? this.operations.get(previousId) : undefined
      if (!previous) continue
      await this.runGuestOnPage(previous, 'cancel').catch(() => undefined)
      this.retire(previous, 'cancelled')
    }
    const opId = randomUUID()
    let operation: ActiveOperation | undefined
    try {
      await this.runtime.withPage(page, 'designArm', async (execution) => {
        this.assertPaneStillTargets(tab, page)
        const previousId = this.operationByPane.get(paneId) ?? this.operationByPage.get(page.browserPageId)
        const previous = previousId ? this.operations.get(previousId) : undefined
        if (previous) this.retire(previous, 'cancelled')
        operation = {
          opId,
          pane: paneId,
          pageId: page.browserPageId,
          worktreeId: tab.worktreeId,
          profileId: tab.profileId,
          expiresAt: this.now() + OPERATION_TIMEOUT_MS,
          binding: { ...execution.binding },
          ...(execution.runtimePage.mainFrameId === undefined ? {} : { mainFrameId: execution.runtimePage.mainFrameId }),
          ...(execution.runtimePage.mainFrameLoaderId === undefined ? {} : { mainFrameLoaderId: execution.runtimePage.mainFrameLoaderId }),
          ...(execution.runtimePage.mainFrameUrl === undefined ? {} : { mainFrameUrl: execution.runtimePage.mainFrameUrl }),
          mode: request.mode,
          subscriptions: [],
          timer: setTimeout(() => { void this.expire(operation!) }, OPERATION_TIMEOUT_MS)
        }
        this.operations.set(opId, operation)
        this.operationByPage.set(page.browserPageId, opId)
        this.operationByPane.set(paneId, opId)
        operation.subscriptions.push(execution.cdp.subscribe('Page.frameNavigated', (event) => {
          if (event.sessionId !== execution.binding.sessionId) return
          const frame = record(event.params.frame)
          if (!frame || frame.id !== operation!.mainFrameId) return
          if (typeof frame.loaderId === 'string' && operation!.mainFrameLoaderId !== undefined && frame.loaderId !== operation!.mainFrameLoaderId) this.cancelAfterNavigation(operation!)
          else if (typeof frame.url === 'string' && operation!.mainFrameUrl !== undefined && frame.url !== operation!.mainFrameUrl) this.cancelAfterNavigation(operation!)
        }))
        operation.subscriptions.push(execution.cdp.subscribe('Page.navigatedWithinDocument', (event) => {
          if (event.sessionId !== execution.binding.sessionId || event.params.frameId !== operation!.mainFrameId) return
          if (typeof event.params.url === 'string' && operation!.mainFrameUrl !== undefined && event.params.url !== operation!.mainFrameUrl) this.cancelAfterNavigation(operation!)
        }))
        guestValue(await execution.cdp.send('Runtime.evaluate', {
          expression: guestProgram('arm', opId, request.mode), returnByValue: true, awaitPromise: false
        }, execution.binding.sessionId, GUEST_CALL_TIMEOUT_MS))
        if (this.operations.get(opId) !== operation) throw fault('browser_tab_changed', 'browser page changed while design mode was arming')
        if (!this.executionMatches(operation, execution)) {
          this.retire(operation, 'cancelled')
          throw fault('browser_tab_changed', 'browser page changed while design mode was arming')
        }
      })
    } catch (error) {
      if (operation) this.retire(operation, 'cancelled')
      throw error
    }
    return { opId }
  }

  async designRead(request: DesignRequests['designRead']): Promise<DesignRead> {
    const pane = requiredString(request?.pane, 'pane')
    const opId = requiredString(request?.opId, 'opId')
    const operation = this.activeOperation(pane, opId)
    if (!operation) return { opId, status: this.retiredStatus(pane, opId) }
    if (this.expired(operation)) return { opId, status: 'expired' }
    const page = this.currentOperationPage(operation)
    if (!page) {
      await this.runGuestOnPage(operation, 'cancel').catch(() => undefined)
      this.retire(operation, 'cancelled')
      return { opId, status: 'cancelled' }
    }
    try {
      const result = await this.runtime.withPage(page, 'designRead', async (execution) => {
        if (!this.executionMatches(operation, execution)) return null
        const raw = guestValue(await execution.cdp.send('Runtime.evaluate', {
          expression: guestProgram('read', opId), returnByValue: true, awaitPromise: false
        }, execution.binding.sessionId, GUEST_CALL_TIMEOUT_MS))
        if (this.operations.get(opId) !== operation || !this.executionMatches(operation, execution)) return null
        return this.clampRead(raw, operation)
      })
      if (!result) {
        const status = this.retiredStatus(pane, opId)
        this.retire(operation, 'cancelled')
        return { opId, status }
      }
      if (result.status === 'expired' || result.status === 'cancelled') this.retire(operation, result.status)
      return result
    } catch (error) {
      if (stalePageError(error)) {
        this.retire(operation, 'cancelled')
        return { opId, status: 'cancelled' }
      }
      throw error
    }
  }

  async designHover(request: DesignRequests['designHover']): Promise<{ payload: DesignPayload | null }> {
    const pane = requiredString(request?.pane, 'pane')
    const opId = requiredString(request?.opId, 'opId')
    const operation = this.activeOperation(pane, opId)
    if (!operation) return { payload: null }
    if (this.expired(operation)) return { payload: null }
    const page = this.currentOperationPage(operation)
    if (!page) {
      await this.runGuestOnPage(operation, 'cancel').catch(() => undefined)
      this.retire(operation, 'cancelled')
      return { payload: null }
    }
    try {
      const payload = await this.runtime.withPage(page, 'designHover', async (execution) => {
        if (!this.executionMatches(operation, execution)) return null
        const raw = guestValue(await execution.cdp.send('Runtime.evaluate', {
          expression: guestProgram('hover', opId), returnByValue: true, awaitPromise: false
        }, execution.binding.sessionId, GUEST_CALL_TIMEOUT_MS))
        if (this.operations.get(opId) !== operation || !this.executionMatches(operation, execution)) return null
        const value = record(raw)?.payload
        if (value === null || value === undefined) return null
        const bounded = this.clampGuestPayload(value)
        operation.hoverPayload = bounded
        return bounded
      })
      if (!payload && this.operations.get(opId) === operation && !this.currentOperationPage(operation)) {
        await this.runGuestOnPage(operation, 'cancel').catch(() => undefined)
        this.retire(operation, 'cancelled')
      }
      return { payload }
    } catch (error) {
      if (stalePageError(error)) {
        this.retire(operation, 'cancelled')
        return { payload: null }
      }
      throw error
    }
  }

  async designCancel(request: DesignRequests['designCancel']): Promise<{ cancelled: true }> {
    const pane = requiredString(request?.pane, 'pane')
    const opId = requiredString(request?.opId, 'opId')
    const operation = this.activeOperation(pane, opId)
    if (!operation) return { cancelled: true }
    await this.cancelOperation(operation)
    return { cancelled: true }
  }

  async cancelPane(pane: string): Promise<void> {
    await this.cancelOperations([...this.operations.values()].filter((operation) => operation.pane === pane))
  }

  async cancelPage(pageId: string): Promise<void> {
    await this.cancelOperations([...this.operations.values()].filter((operation) => operation.pageId === pageId))
  }

  private async cancelOperations(operations: ActiveOperation[]): Promise<void> {
    await Promise.all(operations.map((operation) => this.cancelOperation(operation)))
  }

  private async cancelOperation(operation: ActiveOperation): Promise<void> {
    if (this.operations.get(operation.opId) !== operation) return
    await this.runGuestOnPage(operation, 'cancel').catch(() => undefined)
    this.retire(operation, 'cancelled')
  }

  async designCapture(request: DesignRequests['designCapture']): Promise<{ screenshot: DesignScreenshot | null }> {
    const paneId = requiredString(request?.pane, 'pane')
    const { tab, page } = this.requireWatchPane(paneId)
    let operation: ActiveOperation | undefined
    if (request.opId !== undefined) {
      const opId = requiredString(request.opId, 'opId')
      operation = this.activeOperation(paneId, opId) ?? undefined
      if (!operation) return { screenshot: null }
      if (this.expired(operation)) return { screenshot: null }
      if (operation.pageId !== page.browserPageId) {
        this.retire(operation, 'cancelled')
        return { screenshot: null }
      }
    }
    const givenRect = request.rect === undefined ? undefined : finiteRect(request.rect)
    let targetRect = givenRect ?? operation?.selectionPayload?.target.rectViewport ?? operation?.hoverPayload?.target.rectViewport
    if (!givenRect && !targetRect && operation) {
      const hover = await this.designHover({ pane: paneId, opId: operation.opId })
      targetRect = hover.payload?.target.rectViewport
    }
    if (request.opId !== undefined && !targetRect) return { screenshot: null }
    try {
      const screenshot = await this.runtime.withPage(page, 'designCapture', async (execution) => {
        if (operation && !this.executionMatches(operation, execution)) return null
        this.assertPaneStillTargets(tab, page)
        const captureId = randomUUID()
        const hideId = operation?.opId ?? captureId
        let guestHidden = false
        let annotationSnapshot: AnnotationSnapshot[] | null = null
        try {
          guestValue(await execution.cdp.send('Runtime.evaluate', {
            expression: guestProgram('hide', hideId), returnByValue: true, awaitPromise: false
          }, execution.binding.sessionId, GUEST_CALL_TIMEOUT_MS))
          guestHidden = true
          annotationSnapshot = await this.hideAnnotationOverlays(execution, captureId)
          let clip: Record<string, number> | undefined
          let crop = false
          if (targetRect) {
            const layout = record(await execution.cdp.send('Page.getLayoutMetrics', {}, execution.binding.sessionId, GUEST_CALL_TIMEOUT_MS))
            const viewport = record(layout?.cssVisualViewport) ?? record(layout?.visualViewport)
            if (!viewport || !isFiniteNumber(viewport.pageX) || !isFiniteNumber(viewport.pageY) ||
                !isFiniteNumber(viewport.clientWidth) || !isFiniteNumber(viewport.clientHeight)) return null
            const width = Math.max(0, viewport.clientWidth)
            const height = Math.max(0, viewport.clientHeight)
            const x = Math.max(0, Math.min(width, targetRect.x))
            const y = Math.max(0, Math.min(height, targetRect.y))
            const right = Math.max(x, Math.min(width, targetRect.x + targetRect.width))
            const bottom = Math.max(y, Math.min(height, targetRect.y + targetRect.height))
            if (right <= x || bottom <= y) return null
            clip = { x: viewport.pageX + x, y: viewport.pageY + y, width: right - x, height: bottom - y, scale: 1 }
            crop = true
          }
          const params: Record<string, unknown> = { format: 'png', fromSurface: true, captureBeyondViewport: false }
          if (clip) params.clip = clip
          const capture = record(await execution.cdp.send('Page.captureScreenshot', params, execution.binding.sessionId, CAPTURE_TIMEOUT_MS))
          const data = capture?.data
          if (typeof data !== 'string') return null
          const byteLength = base64ByteLength(data)
          if (byteLength === null || (crop && byteLength > MAX_SCREENSHOT_BYTES)) return null
          const dimensions = pngDimensions(data)
          if (!dimensions) return null
          const screenshot = { mimeType: 'image/png' as const, dataUrl: `data:image/png;base64,${data}`, ...dimensions }
          if (operation && (this.operations.get(operation.opId) !== operation || !this.executionMatches(operation, execution))) return null
          this.assertPaneStillTargets(tab, page)
          return screenshot
        } finally {
          if (annotationSnapshot) await this.restoreAnnotationOverlays(execution, annotationSnapshot)
          if (guestHidden) {
            try {
              await execution.cdp.send('Runtime.evaluate', {
                expression: guestProgram('show', hideId), returnByValue: true, awaitPromise: false
              }, execution.binding.sessionId, GUEST_CALL_TIMEOUT_MS)
            } catch { /* navigation or disposal destroyed the hidden guest */ }
          }
        }
      })
      return { screenshot }
    } catch (error) {
      if (operation && stalePageError(error)) {
        this.retire(operation, 'cancelled')
        return { screenshot: null }
      }
      throw error
    }
  }

  async designFormat(request: DesignRequests['designFormat']): Promise<{ text: string }> {
    const hasPayload = request.payload !== undefined
    const hasAnnotations = request.annotations !== undefined
    if (hasPayload === hasAnnotations) throw fault('invalid_argument', 'designFormat requires exactly one payload or annotations value')
    try {
      if (hasPayload) return { text: formatGrabPayloadAsText(clampPayload(request.payload)) }
      const annotations = clampAnnotations(request.annotations)
      return { text: formatBrowserAnnotationsAsMarkdown(annotations) }
    } catch (error) {
      if (error instanceof BrowserFault) throw error
      throw fault('invalid_argument', error instanceof Error ? error.message : 'designFormat received malformed data')
    }
  }

  async designTargets(request: DesignRequests['designTargets']): Promise<DesignTargets> {
    const paneId = requiredString(request?.pane, 'pane')
    const tab = this.requirePane(paneId)
    const worktreeId = tab.worktreeId
    const result = await this.targetsForWorktree(worktreeId)
    this.assertPaneWorktreeStillExists(paneId, worktreeId)
    return result
  }

  async designSend(request: DesignRequests['designSend']): Promise<{ session: string; delivery: string }> {
    const paneId = requiredString(request?.pane, 'pane')
    const tab = this.requirePane(paneId)
    const annotations = this.clampGuestAnnotations(request.annotations)
      .map((annotation) => ({ ...annotation, comment: sanitizeTerminalControls(annotation.comment) }))
      .filter((annotation) => annotation.comment.trim() !== '')
    if (annotations.length === 0) throw fault('invalid_argument', 'designSend requires at least one annotation')
    const text = sanitizeTerminalControls(formatBrowserAnnotationsAsMarkdown(annotations))
    if (text === '') throw fault('invalid_argument', 'designSend has no feedback to deliver')
    const hasSession = request.session !== undefined
    const hasAgent = request.agent !== undefined
    if (hasSession === hasAgent) throw fault('invalid_argument', 'designSend requires exactly one session or agent target')
    const targets = await this.targetsForWorktree(tab.worktreeId)
    this.assertPaneWorktreeStillExists(paneId, tab.worktreeId)
    if (hasSession) {
      const sessionId = requiredString(request.session, 'session')
      const target = targets.sessions.find((candidate) => candidate.session === sessionId)
      if (!target) throw fault('browser_tab_not_found', 'selected session is not a running target in this pane worktree')
      if (!target.sendable) throw fault('browser_error', target.reason ?? 'selected session cannot accept notes')
      const session = await this.publicSession(sessionId)
      if (session.worktreeId !== tab.worktreeId || session.agent !== target.agent || session.status === 'exited') {
        throw fault('browser_tab_changed', 'selected session no longer belongs to this worktree or is no longer running')
      }
      this.assertPaneWorktreeStillExists(paneId, tab.worktreeId)
      const refusal = this.sessionRefusal(session)
      if (refusal) throw fault('browser_error', refusal)
      const raw = record(await this.context.call('quirky.agents/deliver', {
        sessionId, agent: session.agent, text, submit: true
      }))
      const delivery = raw?.delivery
      if (delivery !== 'pasted' && delivery !== 'unconfirmed' && delivery !== 'not-delivered') {
        throw fault('browser_error', 'agent delivery returned an unknown outcome')
      }
      return { session: sessionId, delivery }
    }
    const agent = requiredString(request.agent, 'agent')
    if (!targets.agents.some((candidate) => candidate.id === agent)) throw fault('browser_tab_not_found', 'selected agent is not available to launch')
    const launched = record(await this.context.call('quirky.terminal/newTab', {
      workspace: tab.worktreeId, agent, prompt: text, title: 'Design feedback'
    }))
    const sessionId = typeof launched?.session === 'string' && launched.session !== '' ? launched.session : ''
    if (sessionId === '') throw fault('browser_error', 'terminal did not return the created agent session ID')
    return await this.settleNewAgentPrompt(paneId, tab.worktreeId, sessionId, agent)
  }

  private requirePane(paneId: string): PaneTab {
    const tab = this.listPanes().find((candidate) => candidate.id === paneId)
    if (!tab) throw fault('browser_tab_not_found', `browser pane ${paneId} is not open`)
    if (typeof tab.worktreeId !== 'string' || tab.worktreeId === '') throw fault('browser_tab_changed', 'browser pane has no worktree identity')
    return tab
  }

  private requireWatchPane(paneId: string): { tab: PaneTab; page: BrowserPage } {
    const tab = this.requirePane(paneId)
    if (tab.mode !== 'watch') throw fault('invalid_argument', 'direct design picker and capture methods are supported only for Watch panes; Native pages use local guest evaluation')
    if (typeof tab.page !== 'string' || tab.page === '') throw fault('browser_no_tab', 'Watch pane has no managed page')
    let page: BrowserPage
    try { page = this.getPage(tab.page) } catch { throw fault('browser_tab_closed', 'Watch pane managed page is no longer available') }
    if (page.browserPageId !== tab.page || page.worktreeId !== tab.worktreeId || page.profileId !== tab.profileId) {
      throw fault('browser_tab_changed', 'Watch pane page, worktree, or profile identity changed')
    }
    return { tab, page }
  }

  private assertPaneStillTargets(tab: PaneTab, page: BrowserPage): void {
    const current = this.listPanes().find((candidate) => candidate.id === tab.id)
    if (!current || current.mode !== 'watch' || current.page !== page.browserPageId || current.worktreeId !== tab.worktreeId || current.profileId !== tab.profileId) {
      throw fault('browser_tab_changed', 'Watch pane no longer targets the same managed page')
    }
  }

  private assertPaneWorktreeStillExists(paneId: string, worktreeId: string): void {
    const current = this.listPanes().find((candidate) => candidate.id === paneId)
    if (!current || current.worktreeId !== worktreeId) throw fault('browser_tab_changed', 'browser pane closed or changed worktree during design delivery')
  }

  private activeOperation(pane: string, opId: string): ActiveOperation | null {
    this.pruneRetired()
    const operation = this.operations.get(opId)
    if (!operation || operation.pane !== pane || this.operationByPage.get(operation.pageId) !== opId || this.operationByPane.get(pane) !== opId) return null
    return operation
  }

  private retiredStatus(pane: string, opId: string): 'cancelled' | 'expired' {
    const retired = this.retired.get(opId)
    return retired?.pane === pane ? retired.status : 'cancelled'
  }

  private currentOperationPage(operation: ActiveOperation): BrowserPage | null {
    const tab = this.listPanes().find((candidate) => candidate.id === operation.pane)
    if (!tab || tab.mode !== 'watch' || tab.page !== operation.pageId || tab.worktreeId !== operation.worktreeId || tab.profileId !== operation.profileId) return null
    try {
      const page = this.getPage(operation.pageId)
      return page.worktreeId === operation.worktreeId && page.profileId === operation.profileId ? page : null
    } catch { return null }
  }

  private executionMatches(operation: ActiveOperation, execution: PageExecution, allowSameDocumentUrlChange = false): boolean {
    return execution.page.browserPageId === operation.pageId && execution.page.worktreeId === operation.worktreeId &&
      execution.page.profileId === operation.profileId && sameBinding(operation.binding, execution.binding) &&
      (operation.mainFrameId === undefined || operation.mainFrameId === execution.runtimePage.mainFrameId) &&
      (operation.mainFrameLoaderId === undefined || operation.mainFrameLoaderId === execution.runtimePage.mainFrameLoaderId) &&
      (allowSameDocumentUrlChange || operation.mainFrameUrl === undefined || operation.mainFrameUrl === execution.runtimePage.mainFrameUrl)
  }

  private clampGuestPayload(raw: unknown): DesignPayload {
    try { return clampPayload(raw) }
    catch { throw fault('browser_tab_changed', 'browser design guest returned malformed or unsafe element data') }
  }

  private clampRead(raw: unknown, operation: ActiveOperation): DesignRead {
    const source = record(raw)
    if (!source || source.opId !== operation.opId || (source.status !== 'armed' && source.status !== 'cancelled' && source.status !== 'expired')) {
      throw fault('browser_tab_changed', 'browser design guest returned an invalid operation status')
    }
    if (source.status !== 'armed') return { opId: operation.opId, status: source.status }
    const rawSelection = record(source.selection)
    if (!rawSelection) return { opId: operation.opId, status: 'armed' }
    if (!['selected', 'context-selected', 'copy', 'screenshot'].includes(String(rawSelection.kind))) {
      throw fault('browser_tab_changed', 'browser design guest returned an invalid selection kind')
    }
    const payload = this.clampGuestPayload(rawSelection.payload)
    operation.selectionPayload = payload
    return { opId: operation.opId, status: 'armed', selection: { kind: rawSelection.kind as 'selected' | 'context-selected' | 'copy' | 'screenshot', payload } }
  }

  private expired(operation: ActiveOperation): boolean {
    if (this.now() < operation.expiresAt) return false
    void this.expire(operation)
    return true
  }

  private async expire(operation: ActiveOperation): Promise<void> {
    if (this.operations.get(operation.opId) !== operation) return
    await this.runGuestOnPage(operation, 'cancel').catch(() => undefined)
    this.retire(operation, 'expired')
  }

  private retire(operation: ActiveOperation, status: 'cancelled' | 'expired'): void {
    if (this.operations.get(operation.opId) !== operation) return
    clearTimeout(operation.timer)
    for (const unsubscribe of operation.subscriptions) unsubscribe()
    operation.subscriptions.length = 0
    this.operations.delete(operation.opId)
    if (this.operationByPage.get(operation.pageId) === operation.opId) this.operationByPage.delete(operation.pageId)
    if (this.operationByPane.get(operation.pane) === operation.opId) this.operationByPane.delete(operation.pane)
    this.retired.delete(operation.opId)
    this.retired.set(operation.opId, { pane: operation.pane, status, expiresAt: this.now() + OPERATION_TOMBSTONE_MS })
    this.pruneRetired()
  }

  private cancelAfterNavigation(operation: ActiveOperation): void {
    this.retire(operation, 'cancelled')
    void this.runGuestOnPage(operation, 'cancel').catch(() => undefined)
  }

  private pruneRetired(): void {
    const now = this.now()
    for (const [opId, retired] of this.retired) if (retired.expiresAt <= now) this.retired.delete(opId)
    while (this.retired.size > MAX_TOMBSTONES) this.retired.delete(this.retired.keys().next().value as string)
  }

  private async runGuestOnPage(operation: ActiveOperation, action: DesignGuestAction): Promise<void> {
    const page = (() => {
      try { return this.getPage(operation.pageId) } catch { return null }
    })()
    if (!page || page.worktreeId !== operation.worktreeId || page.profileId !== operation.profileId) return
    await this.runtime.withPage(page, `design${action}`, async (execution) => {
      if (!this.executionMatches(operation, execution, action === 'cancel')) return
      await execution.cdp.send('Runtime.evaluate', {
        expression: guestProgram(action, operation.opId, operation.mode), returnByValue: true, awaitPromise: false
      }, execution.binding.sessionId, GUEST_CALL_TIMEOUT_MS)
    })
  }

  private async hideAnnotationOverlays(execution: PageExecution, captureId: string): Promise<AnnotationSnapshot[]> {
    const expression = `(() => {
      const nodes = Array.from(document.querySelectorAll('[${OWNER_ANNOTATION_ATTRIBUTE}]'));
      return nodes.map((node, index) => {
        const key = ${JSON.stringify(captureId)} + '-' + index;
        const visibility = node.style.getPropertyValue('visibility');
        const priority = node.style.getPropertyPriority('visibility');
        node.setAttribute('${CAPTURE_MARKER_ATTRIBUTE}', key);
        node.style.setProperty('visibility', 'hidden', 'important');
        return { key, visibility, priority };
      });
    })()`
    const raw = guestValue(await execution.cdp.send('Runtime.evaluate', {
      expression, returnByValue: true
    }, execution.binding.sessionId, GUEST_CALL_TIMEOUT_MS))
    if (!Array.isArray(raw)) throw fault('browser_eval_error', 'could not hide browser annotation overlays for capture')
    const snapshots: AnnotationSnapshot[] = []
    for (const value of raw) {
      const item = record(value)
      if (!item || typeof item.key !== 'string' || typeof item.visibility !== 'string' || typeof item.priority !== 'string') {
        throw fault('browser_eval_error', 'browser annotation overlay state was malformed')
      }
      snapshots.push({ key: item.key, visibility: item.visibility, priority: item.priority })
    }
    return snapshots
  }

  private async restoreAnnotationOverlays(execution: PageExecution, snapshots: AnnotationSnapshot[]): Promise<void> {
    const snapshot = JSON.stringify(snapshots)
    const expression = `(() => {
      const snapshots = ${snapshot};
      for (const previous of snapshots) {
        const selector = '[${CAPTURE_MARKER_ATTRIBUTE}=\"' + previous.key + '\"]';
        const node = document.querySelector(selector);
        if (!node) continue;
        if (previous.visibility === '') node.style.removeProperty('visibility');
        else node.style.setProperty('visibility', previous.visibility, previous.priority);
        node.removeAttribute('${CAPTURE_MARKER_ATTRIBUTE}');
      }
      return true;
    })()`
    try {
      await execution.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, execution.binding.sessionId, GUEST_CALL_TIMEOUT_MS)
    } catch { /* navigation or disposal destroyed the elements */ }
  }


  private clampGuestAnnotations(raw: unknown): DesignAnnotation[] {
    try { return clampAnnotations(raw) }
    catch (error) { throw fault('invalid_argument', error instanceof Error ? error.message : 'designSend received malformed annotations') }
  }

  private async targetsForWorktree(worktreeId: string): Promise<DesignTargets> {
    const worktrees = await this.context.call('quirky.worktree/list', {})
    if (!Array.isArray(worktrees) || !worktrees.some((value) => {
      const item = record(value)
      return item?.id === worktreeId && typeof item.name === 'string' && typeof item.path === 'string'
    })) throw fault('browser_tab_not_found', 'pane worktree no longer exists')
    const [sessionsValue, terminalsValue, agentsValue] = await Promise.all([
      this.context.call('quirky.session/list', { worktree: `id:${worktreeId}` }),
      this.context.call('quirky.terminal/sessions', {}),
      this.context.call('quirky.agents/list', {})
    ])
    if (!Array.isArray(sessionsValue)) throw fault('browser_error', 'session plugin returned an invalid session list')
    const terminalEnvelope = record(terminalsValue)
    const terminalRows = terminalEnvelope?.sessions
    if (!Array.isArray(terminalRows)) throw fault('browser_error', 'terminal plugin returned an invalid running-session list')
    const agentEnvelope = record(agentsValue)
    if (!Array.isArray(agentEnvelope?.agents)) throw fault('browser_error', 'agent plugin returned an invalid agent list')
    const sessions = sessionsValue.map((value) => record(value)).filter((item): item is Record<string, unknown> => item !== null) as unknown as SessionRecord[]
    const terminals = terminalRows.map((value) => record(value)).filter((item): item is Record<string, unknown> => item !== null) as unknown as TerminalRecord[]
    const agentRecords = agentEnvelope.agents.map((value: unknown) => record(value)).filter((item: Record<string, unknown> | null): item is Record<string, unknown> => item !== null) as unknown as AgentRecord[]
    const terminalById = new Map(terminals.map((terminal) => [terminal.sessionId, terminal]))
    const targets: DesignTarget[] = []
    for (const session of sessions) {
      if (session.worktreeId !== worktreeId || session.kind !== 'terminal' || typeof session.id !== 'string' || typeof session.agent !== 'string' || session.agent === 'shell') continue
      const terminal = terminalById.get(session.id)
      const display = session.agentStatus?.display ?? session.status
      const state = session.agentStatus?.label ?? (typeof display === 'string' ? display : null)
      const refusal = this.sessionRefusal(session)
      const terminalRunning = terminal?.state === 'running' && terminal.worktreeId === worktreeId
      const sendable = terminalRunning && refusal === null
      const reason = !terminalRunning ? 'Terminal session is not running in this worktree.' : refusal ?? undefined
      const title = targetText(session.title, targetText(session.agent, 'Agent'))
      const label = targetText(session.name ?? session.title ?? session.agent, 'Agent')
      targets.push({
        session: session.id,
        agent: session.agent,
        label,
        title,
        status: targetText(session.status),
        state: state === null ? null : targetText(state),
        lastActivityAt: isFiniteNumber(session.lastActivityAt) ? session.lastActivityAt : 0,
        sendable,
        ...(reason ? { reason } : {})
      })
    }
    const agents = agentRecords.filter((agent) => typeof agent.id === 'string' && typeof agent.label === 'string' && agent.installed === true && agent.enabled === true)
      .map((agent) => ({ id: targetText(agent.id), label: targetText(agent.label) }))
    return { sessions: targets, agents }
  }

  private async publicSession(sessionId: string): Promise<SessionRecord> {
    const value = record(await this.context.call('quirky.session/get', { session: sessionId }))
    if (!value || typeof value.id !== 'string' || typeof value.agent !== 'string' || typeof value.status !== 'string') {
      throw fault('browser_error', 'session plugin returned an invalid session record')
    }
    return value as unknown as SessionRecord
  }

  private sessionRefusal(session: SessionRecord): string | null {
    if (session.status === 'exited') return 'Session is no longer running.'
    if (session.status === 'starting') return 'Session is still starting.'
    if (session.agentStatus?.display === 'permission') return 'Agent needs permission before notes can be delivered.'
    if (session.agentStatus?.state === 'blocked' || session.agentStatus?.display === 'blocked') return 'Agent is blocked.'
    if (session.status === 'waiting' || session.agentStatus?.state === 'waiting' || session.agentStatus?.display === 'waiting') {
      return 'Agent is waiting for input.'
    }
    return null
  }

  private async settleNewAgentPrompt(pane: string, worktreeId: string, sessionId: string, agentId: string): Promise<{ session: string; delivery: string }> {
    const deadline = this.now() + NEW_AGENT_SETTLE_TIMEOUT_MS
    let session = await this.publicSession(sessionId)
    if (session.worktreeId !== worktreeId || session.agent !== agentId) throw fault('browser_tab_changed', 'new agent session is not bound to this pane worktree and selected agent')
    while (session.promptDelivery === 'pending' && session.status !== 'exited' && this.now() < deadline) {
      this.assertPaneWorktreeStillExists(pane, worktreeId)
      const delay = Promise.withResolvers<void>()
      setTimeout(delay.resolve, NEW_AGENT_POLL_MS)
      await delay.promise
      session = await this.publicSession(sessionId)
      if (session.worktreeId !== worktreeId || session.agent !== agentId) throw fault('browser_tab_changed', 'new agent session changed identity while its prompt was being delivered')
    }
    const delivery = session.promptDelivery
    if (delivery === 'pasted' || delivery === 'command-line' || delivery === 'unconfirmed' || delivery === 'not-delivered') {
      return { session: sessionId, delivery }
    }
    if (delivery === 'pending') return { session: sessionId, delivery }
    throw fault('browser_error', 'new agent prompt delivery did not settle to a public outcome')
  }
}
