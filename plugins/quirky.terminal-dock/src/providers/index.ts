import type { PluginContext, Session } from '@quirky/protocol'
import type { DockOptions, DockQuestion } from '../types'
import {
  formatAnswerText,
  isQuestionTool,
  normalizeAnswers,
  permissionFromEnvelope,
  permissionFromHeld,
  questionFromInput,
  safeAnswerText,
  type AnswerGroup
} from './questions'
import {
  isRecognizedQuestionTool,
  newestPendingQuestionCall,
  readProviderTranscript,
  transcriptObserved,
  transcriptPrompts,
  type TranscriptSnapshot
} from './transcripts'

export type ProviderBridge = {
  read(session: Session): Promise<{ question: DockQuestion | null; options: DockOptions; prompts: string[] }>
  answer(session: Session, question: DockQuestion, answers: string[][], signal: AbortSignal): Promise<{ confirmed: boolean; notice: string }>
  setOption(session: Session, kind: 'model' | 'effort' | 'permission', value: string, signal: AbortSignal): Promise<{ confirmed: boolean; notice: string }>
  observed(session: Session, text: string, since: number): Promise<boolean>
  dispose(): void
}

type StatusRow = {
  sessionId: string
  agent: string
  state: 'working' | 'waiting' | 'blocked' | 'done'
  question?: string
  toolName?: string
  toolInput?: string
  heldPermission?: { toolUseId: string | null; toolName: string; input: string; childId: string | null }
  lead: { providerSession: string | null; ended: boolean }
  stateStartedAt: number
  evidenceAt: number
  turnStartedAt: number | null
  source: string
  restoredUnconfirmed?: boolean
  model?: string
  prompt: string
}

type PublicOption = { value: string; label: string }
type PublicAgentOptions = {
  supported?: boolean
  models?: { id: string; label: string; options?: { id: string; choices: PublicOption[] | null }[] }[]
}

type LiveState = {
  status: StatusRow | null
  transcript: TranscriptSnapshot
  providerSession: string
  question: DockQuestion | null
  statusError: string | null
}

type OptionCatalog = { models: { id: string; label: string; options: { id: string; choices: PublicOption[] }[] }[] }
type PermissionEvidence = { current: string | null; choices: string[]; notice: string | null }
type CodexPermissionChoice = { value: string; label: string; row: number }
type CodexPermissionMenu = { choices: CodexPermissionChoice[] }
type WriteFailure = { accepted: boolean; uncertain: boolean; notice: string | null }

const SUPPORTED_AGENTS: Record<string, true> = {
  claude: true, openclaude: true, codex: true, grok: true, omp: true, opencode: true, opencode2: true, zcode: true
}
const SELECTOR_AGENTS: Record<string, true> = {
  claude: true, openclaude: true, codex: true, opencode: true, opencode2: true, zcode: true
}
const ENTER = '\r'
const ESCAPE = '\u001b'
const RIGHT = '\u001b[C'
const SHIFT_TAB = '\u001b[Z'
const DOWN = '\u001b[B'
const UP = '\u001b[A'
const TAB = '\t'
const BRACKETED_PASTE_START = '\u001b[200~'
const BRACKETED_PASTE_END = '\u001b[201~'
const OPTION_DELAY_MS = 120
const PASTE_SUBMIT_DELAY_MS = 500
const SELECTOR_GROUP_DELAY_MS = 1_000
const MAX_OPTION_NAVIGATION_STEPS = 100

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function cleanStatus(value: unknown, session: Session): StatusRow | null {
  const row = asRecord(value)
  const lead = asRecord(row?.lead)
  if (
    !row || row.sessionId !== session.id || row.agent !== session.agent ||
    !['working', 'waiting', 'blocked', 'done'].includes(String(row.state)) || !lead ||
    typeof lead.ended !== 'boolean' || typeof row.stateStartedAt !== 'number' ||
    typeof row.evidenceAt !== 'number' || (row.turnStartedAt !== null && typeof row.turnStartedAt !== 'number') ||
    typeof row.source !== 'string' || typeof row.prompt !== 'string'
  ) return null
  const held = asRecord(row.heldPermission)
  return {
    sessionId: row.sessionId as string,
    agent: row.agent as string,
    state: row.state as StatusRow['state'],
    ...(typeof row.question === 'string' ? { question: row.question } : {}),
    ...(typeof row.toolName === 'string' ? { toolName: row.toolName } : {}),
    ...(typeof row.toolInput === 'string' ? { toolInput: row.toolInput } : {}),
    ...(held && typeof held.toolName === 'string' && typeof held.input === 'string' ? {
      heldPermission: {
        toolUseId: typeof held.toolUseId === 'string' ? held.toolUseId : null,
        toolName: held.toolName,
        input: held.input,
        childId: typeof held.childId === 'string' ? held.childId : null
      }
    } : {}),
    lead: {
      providerSession: typeof lead.providerSession === 'string' ? lead.providerSession : null,
      ended: lead.ended
    },
    stateStartedAt: row.stateStartedAt,
    evidenceAt: row.evidenceAt,
    turnStartedAt: typeof row.turnStartedAt === 'number' ? row.turnStartedAt : null,
    source: row.source,
    ...(row.restoredUnconfirmed === true ? { restoredUnconfirmed: true } : {}),
    ...(typeof row.model === 'string' ? { model: row.model } : {}),
    prompt: row.prompt
  }
}

function isLiveWait(status: StatusRow | null, session: Session): status is StatusRow {
  return !!status && session.status !== 'exited' && status.lead.ended === false &&
    status.restoredUnconfirmed !== true && (status.state === 'waiting' || status.state === 'blocked')
}

function questionIdentity(status: StatusRow, providerSession: string) {
  return {
    agent: status.agent,
    providerSession,
    turnStartedAt: status.turnStartedAt,
    stateStartedAt: status.stateStartedAt,
    eventAt: status.evidenceAt
  }
}

function statusQuestion(status: StatusRow | null, session: Session, providerSession: string): DockQuestion | null {
  if (!isLiveWait(status, session) || status.source !== 'hook') return null
  const identity = questionIdentity(status, providerSession)
  if (status.heldPermission) return permissionFromHeld(status.heldPermission, identity)
  if (!status.question) return null
  const permission = permissionFromEnvelope(status.question, identity)
  if (permission) return permission
  if (!status.toolName || !isQuestionTool(status.toolName)) return null
  return questionFromInput(status.question, identity)
}

function sameQuestionContent(left: DockQuestion, right: DockQuestion): boolean {
  if (left.id !== right.id || left.kind !== right.kind || left.title !== right.title || left.questions.length !== right.questions.length) return false
  return left.questions.every((question, index) => {
    const other = right.questions[index]!
    return question.prompt === other.prompt && question.multiple === other.multiple &&
      question.choices.length === other.choices.length &&
      question.choices.every((choice, choiceIndex) =>
        choice.value === other.choices[choiceIndex]!.value && choice.label === other.choices[choiceIndex]!.label)
  })
}
function sameProviderSession(status: StatusRow | null, providerSession: string): boolean {
  return !status?.lead.providerSession || status.lead.providerSession === providerSession
}

function transcriptQuestion(status: StatusRow | null, session: Session, providerSession: string, transcript: TranscriptSnapshot): DockQuestion | null {
  if (!isLiveWait(status, session)) return null
  return newestPendingQuestionCall(transcript, (name, input, callId, at) => {
    if (!isRecognizedQuestionTool(name)) return null
    return questionFromInput(input, {
      agent: session.agent,
      providerSession,
      requestId: callId,
      turnStartedAt: status.turnStartedAt,
      stateStartedAt: status.stateStartedAt,
      eventAt: at
    })
  })
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function mergeNotice(...messages: (string | null | undefined)[]): string | null {
  const unique = [...new Set(messages.map((message) => message?.trim()).filter((message): message is string => !!message))]
  return unique.length ? unique.join(' ') : null
}

function emptyOptions(notice: string | null = null): DockOptions {
  return { model: null, effort: null, permission: null, choices: { model: [], effort: [], permission: [] }, context: null, notice }
}

function findModel(models: OptionCatalog['models'], id: string | null): OptionCatalog['models'][number] | undefined {
  if (!id) return undefined
  const target = normalized(id)
  return models.find((model) => normalized(model.id) === target || normalized(model.label) === target) ??
    models.find((model) => target.length >= 4 && (
      normalized(model.id).includes(target) || target.includes(normalized(model.id)) ||
      normalized(model.label).includes(target) || target.includes(normalized(model.label))
    ))
}

function stringChoices(values: PublicOption[]): string[] {
  return [...new Set(values.flatMap((item) => typeof item.value === 'string' && item.value.trim() ? [item.value] : []))]
}

function catalogOptions(value: unknown): OptionCatalog | null {
  const raw = asRecord(value) as PublicAgentOptions | null
  if (!raw || raw.supported !== true || !Array.isArray(raw.models)) return null
  const models = raw.models.flatMap((model) => {
    if (!model || typeof model.id !== 'string' || typeof model.label !== 'string' || !Array.isArray(model.options)) return []
    return [{
      id: model.id,
      label: model.label,
      options: model.options.flatMap((option) => option && typeof option.id === 'string' && Array.isArray(option.choices)
        ? [{ id: option.id, choices: option.choices.filter((choice): choice is PublicOption => !!choice && typeof choice.value === 'string' && typeof choice.label === 'string') }]
        : [])
    }]
  })
  return { models }
}

function optionsFromEvidence(status: StatusRow | null, transcript: TranscriptSnapshot, catalog: OptionCatalog | null): DockOptions {
  const model = stringValue(status?.model) ?? transcript.model
  const selectedModel = findModel(catalog?.models ?? [], model)
  const effortOption = selectedModel?.options.find((option) => ['effort', 'reasoning_effort', 'reasoning-effort'].includes(option.id))
  return {
    model,
    effort: transcript.effort,
    permission: null,
    choices: {
      model: (catalog?.models ?? []).map((entry) => entry.id),
      effort: stringChoices(effortOption?.choices ?? []),
      permission: []
    },
    context: transcript.context,
    notice: mergeNotice(
      transcript.notice,
      !model ? 'The session has not reported its current model.' : null,
      !transcript.effort ? 'The session has not reported its current effort.' : null
    )
  }
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
}

function screenRows(value: string): string[] {
  return stripAnsi(value).split(/\n+/).map((line) => line.trim()).filter(Boolean)
}

function selectedRowIndex(rows: string[]): number {
  return rows.findIndex((line) => /^(?:❯|›|➤|>)(?:\s|$)/u.test(line))
}

function targetRowIndex(rows: string[], label: string): number {
  const wanted = normalized(label)
  if (!wanted) return -1
  return rows.findIndex((line) => normalized(line.replace(/^(?:❯|›|➤|>)\s*/u, '')).includes(wanted))
}

function screenHasQuestion(screen: string, question: DockQuestion): boolean {
  const compact = normalized(screen)
  if (question.kind === 'permission') {
    return compact.includes(normalized(question.title)) && (compact.includes('deny') || compact.includes('escape') || compact.includes('accept'))
  }
  return question.questions.some((item) => {
    const prompt = normalized(item.prompt)
    if (!prompt || !compact.includes(prompt)) return false
    return item.choices.length === 0 || item.choices.some((choice) => compact.includes(normalized(choice.label)))
  })
}
function screenShowsSelectorSubmit(screen: string): boolean {
  return normalized(screen).includes('submit') || normalized(screen).includes('confirmanswers')
}

function screenShowsPersistentConfirmation(screen: string): boolean {
  const text = normalized(screen)
  return text.includes('saveasdefault') || text.includes('newdefault') || text.includes('persistthis') || text.includes('globally')
}

function hasSessionOnlyAction(screen: string): boolean {
  return /(?:\bpress\s+s\b|\buse\s+s\b|\[s\])\s*(?:for|to)?[^\n]{0,80}(?:session|conversation)|(?:session|conversation)[^\n]{0,80}(?:\bpress\s+s\b|\buse\s+s\b|\[s\])/i.test(stripAnsi(screen))
}

const CODEX_PERMISSION_CHOICES = ['read-only', 'ask', 'auto', 'full-access']

function terminalPermissionMode(agent: string, screen: string | null): string | null {
  if (!screen || (agent !== 'claude' && agent !== 'openclaude')) return null
  const found = new Set<string>()
  for (const line of stripAnsi(screen).split(/\n+/)) {
    const text = normalized(line)
    if (!text.includes('shifttabtocycle') && !/[⏸⏵▶]/u.test(line)) continue
    if (agent === 'claude' && (text.includes('manualmodeon') || text.includes('defaultmodeon'))) found.add('ask')
    if (agent === 'openclaude' && text.includes('defaulton')) found.add('ask')
    if (text.includes('accepteditson')) found.add('accept-edits')
    if (text.includes('planmodeon')) found.add('plan')
    if (text.includes('automodeon')) found.add('auto')
    if (text.includes('dontaskon')) found.add('dont-ask')
    if (text.includes('bypasspermissionson')) found.add('bypass-permissions')
    if (text.includes('fullaccesson')) found.add('full-access')
  }
  return found.size === 1 ? [...found][0]! : null
}

function safePermissionTargets(agent: string, current: string): string[] {
  switch (current) {
    case 'ask': return ['ask', 'accept-edits', 'plan']
    case 'accept-edits': return ['accept-edits', 'plan']
    case 'plan': return ['plan']
    case 'auto': return ['auto', 'ask']
    case 'bypass-permissions': return agent === 'claude' ? ['bypass-permissions', 'ask'] : ['bypass-permissions']
    case 'full-access': return agent === 'openclaude' ? ['full-access', 'ask'] : ['full-access']
    default: return [current]
  }
}

function safePermissionNext(agent: string, current: string): string[] {
  switch (current) {
    case 'ask': return ['accept-edits']
    case 'accept-edits': return ['plan']
    case 'auto': return ['ask']
    case 'bypass-permissions': return agent === 'claude' ? ['auto', 'ask'] : ['full-access']
    case 'full-access': return agent === 'openclaude' ? ['auto', 'ask'] : []
    default: return []
  }
}

function codexPermissionChoice(line: string, row: number): CodexPermissionChoice | null {
  const label = line.replace(/^\s*(?:❯|›|➤|>)\s*/u, '').replace(/^\d+\s*[.)]\s*/, '').trim()
  const text = normalized(label)
  if (text.startsWith('readonly')) return { value: 'read-only', label: 'Read Only', row }
  if (text.startsWith('askforapproval')) return { value: 'ask', label: 'Ask for approval', row }
  if (text === 'auto' || text.startsWith('approveforme') || text.startsWith('automode') || text.startsWith('autoreview')) {
    return { value: 'auto', label, row }
  }
  if (text.startsWith('fullaccess')) return { value: 'full-access', label: 'Full Access', row }
  return null
}

function codexPermissionMenu(screen: string | null): CodexPermissionMenu | null {
  if (!screen || !normalized(screen).includes('permission')) return null
  const rows = screenRows(screen)
  const choices = rows.flatMap((line, row) => {
    const choice = codexPermissionChoice(line, row)
    return choice ? [choice] : []
  })
  if (choices.length < 2) return null
  return { choices }
}

function screenOwnsApprovalInput(agent: string, screen: string | null): boolean {
  if (!screen) return false
  if (agent === 'codex' && codexPermissionMenu(screen)) return false
  const text = normalized(screen)
  if (text.includes('askuserquestion') || text.includes('requestuserinput')) return true
  const approvalAction = text.includes('permissionrequest') || text.includes('allow') || text.includes('approve')
  const numberedNoChoice = /(?:^|\n)\s*(?:\d+[.)]\s*)no(?:\s|$)/i.test(stripAnsi(screen))
  const rejectionAction = text.includes('deny') || text.includes('reject') || text.includes('escape') || numberedNoChoice
  return approvalAction && rejectionAction
}

function unsupportedPermissionNotice(agent: string): string {
  switch (agent) {
    case 'grok':
      return 'Grok exposes individual approval requests, but no session permission-mode control is evidenced.'
    case 'omp':
      return 'OMP approval changes through /settings or config and persists; the dock refuses global permission writes.'
    case 'opencode':
    case 'opencode2':
      return 'OpenCode has a session auto-approve toggle, not an absolute mode for its per-tool permission rules.'
    case 'zcode':
      return 'ZCode has no evidenced session-only permission-mode control.'
    default:
      return `No session-only permission-mode control is evidenced for ${agent}.`
  }
}

function permissionEvidence(agent: string, screen: string | null): PermissionEvidence {
  if (agent === 'claude' || agent === 'openclaude') {
    const current = terminalPermissionMode(agent, screen)
    if (!current) {
      return { current: null, choices: [], notice: `The current ${agent} permission mode is not visible in the terminal status bar.` }
    }
    return { current, choices: safePermissionTargets(agent, current), notice: null }
  }
  if (agent === 'codex') {
    const menu = codexPermissionMenu(screen)
    return {
      current: null,
      choices: menu ? [...new Set(menu.choices.map((choice) => choice.value))] : CODEX_PERMISSION_CHOICES,
      notice: menu
        ? 'Codex highlights a picker row but does not report the active preset.'
        : 'Codex does not report its active permission preset outside /permissions.'
    }
  }
  return { current: null, choices: [], notice: unsupportedPermissionNotice(agent) }
}

function hasEmptyInputPrompt(screen: string): boolean {
  return /(?:^|\n)\s*(?:❯|›|➤|>)\s*$/mu.test(stripAnsi(screen))
}

function optionLabel(catalog: OptionCatalog | null, kind: 'model' | 'effort', value: string): string | null {
  if (!catalog) return null
  if (kind === 'model') return catalog.models.find((model) => model.id === value)?.label ?? null
  const choices = catalog.models.flatMap((model) => model.options
    .filter((option) => ['effort', 'reasoning_effort', 'reasoning-effort'].includes(option.id))
    .flatMap((option) => option.choices))
  return choices.find((choice) => choice.value === value)?.label ?? null
}

function optionIsCurrent(kind: 'model' | 'effort', value: string, live: LiveState): boolean {
  const current = kind === 'model' ? stringValue(live.status?.model) ?? live.transcript.model : live.transcript.effort
  return !!current && normalized(current) === normalized(value)
}

function optionScreenConfirms(screen: string, kind: 'model' | 'effort', value: string, label: string): boolean {
  const compact = normalized(screen)
  const target = normalized(label || value)
  if (!compact.includes(target)) return false
  return kind === 'model'
    ? /(?:currentmodel|model(?:is|:|=))/.test(compact)
    : /(?:currenteffort|effort(?:is|:|=))/.test(compact)
}

function questionSteps(agent: string, question: DockQuestion, groups: AnswerGroup[]): { values: string[]; error: string | null } {
  if (question.kind === 'permission') return { values: [], error: null }
  const values: string[] = []
  const selectorFamily = SELECTOR_AGENTS[agent] === true
  if (!selectorFamily) return { values: [], error: null }
  for (let index = 0; index < question.questions.length; index++) {
    const prompt = question.questions[index]!
    const answer = groups[index]!
    if (answer.text !== null) {
      if (agent === 'codex') {
        for (let n = 0; n < prompt.choices.length; n++) values.push(DOWN)
        values.push(TAB, `${BRACKETED_PASTE_START}${safeAnswerText(answer.text)}${BRACKETED_PASTE_END}`, ENTER)
      } else {
        if (prompt.choices.length >= 9) return { values: [], error: 'This selector has too many rows to address safely.' }
        values.push(String(prompt.choices.length + 1), `${BRACKETED_PASTE_START}${safeAnswerText(answer.text)}${BRACKETED_PASTE_END}`, ENTER)
      }
      continue
    }
    if (answer.indexes.some((choiceIndex) => choiceIndex >= 9)) return { values: [], error: 'This selector has too many rows to address safely.' }
    if (prompt.multiple && agent !== 'codex') {
      values.push(...answer.indexes.map((choiceIndex) => String(choiceIndex + 1)), RIGHT)
      continue
    }
    if (prompt.multiple && agent === 'codex') return { values: [], error: 'Codex multi-select navigation is not supported by this selector.' }
    values.push(String(answer.indexes[0]! + 1))
  }
  if (agent !== 'codex' && (question.questions.length > 1 || question.questions[0]?.multiple)) values.push(ENTER)
  return { values, error: null }
}

function terminalNotice(error: unknown, acceptedBefore: boolean): WriteFailure {
  const failure = error as { code?: unknown; acceptedBytes?: unknown }
  const code = typeof failure?.code === 'string' ? failure.code : ''
  const acceptedBytes = typeof failure?.acceptedBytes === 'number' ? failure.acceptedBytes : null
  const uncertain = code === 'PTY_WRITE_UNCERTAIN' || acceptedBytes === null || acceptedBytes > 0
  const accepted = uncertain || (acceptedBytes !== null && acceptedBytes > 0) || acceptedBefore
  return {
    accepted,
    uncertain,
    notice: uncertain || acceptedBefore
      ? 'The answer may have reached the terminal, but the provider has not confirmed it.'
      : 'The terminal refused the answer before accepting any bytes.'
  }
}

export function createProviderBridge(context: PluginContext): ProviderBridge {
  let disposed = false
  const disposeController = new AbortController()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const answered = new Set<string>()

  const operationSignal = (signal: AbortSignal): AbortSignal => AbortSignal.any([signal, disposeController.signal])
  const withinDeadline = <T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    let settled = false
    if (disposed || disposeController.signal.aborted) {
      reject(new Error('Provider bridge was disposed.'))
      return promise
    }
    const finish = (work: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      timers.delete(timer)
      disposeController.signal.removeEventListener('abort', aborted)
      work()
    }
    const aborted = (): void => finish(() => reject(new Error('Provider bridge was disposed.')))
    const timer = setTimeout(() => finish(() => reject(new Error(message))), timeoutMs)
    timer.unref?.()
    timers.add(timer)
    disposeController.signal.addEventListener('abort', aborted, { once: true })
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    )
    return promise
  }

  const delay = (ms: number, signal: AbortSignal): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>()
    if (signal.aborted || disposed) {
      resolve(false)
      return promise
    }
    const aborted = () => {
      clearTimeout(timer)
      timers.delete(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      signal.removeEventListener('abort', aborted)
      resolve(true)
    }, ms)
    timers.add(timer)
    signal.addEventListener('abort', aborted, { once: true })
    return promise
  }

  const readStatus = async (session: Session): Promise<{ status: StatusRow | null; error: string | null }> => {
    try {
      const raw = await withinDeadline(context.call('quirky.agent-status/get', { session: session.id }), 3_000, 'Agent status lookup timed out.')
      return { status: cleanStatus(raw, session), error: null }
    } catch {
      return { status: null, error: 'Agent status could not be read.' }
    }
  }

  const liveState = async (session: Session): Promise<LiveState> => {
    const { status, error } = await readStatus(session)
    const providerSession = status?.lead.providerSession ?? session.providerSession?.id ?? session.id
    const transcript = await withinDeadline(readProviderTranscript(session, providerSession), 3_000, 'Provider transcript lookup timed out.').catch((error: unknown) => ({
      events: [],
      model: null,
      effort: null,
      context: null,
      modifiedAt: null,
      source: null,
      notice: error instanceof Error ? error.message : 'Provider transcript lookup failed.'
    }))
    const hook = statusQuestion(status, session, providerSession)
    const transcriptQuestionCurrent = transcriptQuestion(status, session, providerSession, transcript)
    let question = hook
    if (transcriptQuestionCurrent && (!hook || (transcript.modifiedAt !== null && status && status.evidenceAt < transcript.modifiedAt - 1_000))) {
      question = transcriptQuestionCurrent
    }
    return { status, transcript, providerSession, question, statusError: error }
  }

  const readOptionCatalog = async (session: Session): Promise<{ catalog: OptionCatalog | null; error: string | null }> => {
    try {
      const value = await withinDeadline(context.call('quirky.agents/options', { agent: session.agent }), 3_000, 'Session-option catalog lookup timed out.')
      const catalog = catalogOptions(value)
      return { catalog, error: catalog ? null : 'This agent has no public session-option catalog.' }
    } catch {
      return { catalog: null, error: 'The public session-option catalog could not be read.' }
    }
  }

  const readOptions = async (session: Session, live: LiveState): Promise<DockOptions> => {
    if (!SUPPORTED_AGENTS[session.agent]) return emptyOptions('This terminal agent has no supported provider adapter.')
    const { catalog, error } = await readOptionCatalog(session)
    const options = optionsFromEvidence(live.status, live.transcript, catalog)
    const screen = await readScreen(session)
    const evidence = permissionEvidence(session.agent, screen)
    const inputOwned = !!live.question && !answered.has(live.question.id) || screenOwnsApprovalInput(session.agent, screen)
    const permission = inputOwned
      ? { ...evidence, choices: [], notice: 'Resolve the active question or approval prompt before changing session options.' }
      : evidence
    return {
      ...options,
      permission: permission.current,
      choices: { ...options.choices, permission: permission.choices },
      notice: mergeNotice(options.notice, permission.notice, live.statusError, live.transcript.notice, error,
        !live.status ? 'Agent status is not available.' : null)
    }
  }

  const read = async (session: Session): Promise<{ question: DockQuestion | null; options: DockOptions; prompts: string[] }> => {
    if (disposed) return { question: null, options: emptyOptions('Provider bridge is disposed.'), prompts: [] }
    const live = await liveState(session)
    const question = live.question && !answered.has(live.question.id) ? live.question : null
    const prompts = [...new Set([
      ...(live.status?.prompt ? [live.status.prompt] : []),
      ...transcriptPrompts(live.transcript)
    ])].slice(-200)
    return { question, options: await readOptions(session, live), prompts }
  }

  const currentRequest = async (session: Session, request: DockQuestion, signal: AbortSignal): Promise<LiveState | null> => {
    if (disposed || signal.aborted || answered.has(request.id)) return null
    const live = await liveState(session)
    if (!live.question || !sameQuestionContent(live.question, request) || !sameProviderSession(live.status, live.providerSession)) return null
    return live
  }

  const readScreen = async (session: Session): Promise<string | null> => {
    try {
      const screen = await withinDeadline(context.pty.read(session.id, 200), 3_000, 'Provider terminal screen lookup timed out.')
      return screen.lines.join('\n')
    } catch {
      return null
    }
  }

  const writeAnswerStep = async (
    session: Session,
    question: DockQuestion,
    data: string,
    signal: AbortSignal,
    acceptedBefore: boolean
  ): Promise<WriteFailure> => {
    if (!await currentRequest(session, question, signal)) {
      return { accepted: acceptedBefore, uncertain: false, notice: 'The provider request is stale or has already resolved; no further answer keys were sent.' }
    }
    const screen = await readScreen(session)
    if (screen === null || (!screenHasQuestion(screen, question) && !(data === ENTER && question.kind === 'question' && screenShowsSelectorSubmit(screen)))) {
      return { accepted: acceptedBefore, uncertain: false, notice: 'The expected provider question is not visible; refusing to guess at terminal input.' }
    }
    if (signal.aborted || disposed) {
      return { accepted: acceptedBefore, uncertain: false, notice: acceptedBefore ? 'The answer was cancelled after terminal input.' : 'The answer was cancelled before terminal input.' }
    }
    if (!await currentRequest(session, question, signal)) {
      return { accepted: acceptedBefore, uncertain: false, notice: 'The provider request changed while the terminal screen was read; no further answer keys were sent.' }
    }
    try {
      await context.pty.writeAccepted(session.id, data)
      return { accepted: true, uncertain: false, notice: null }
    } catch (error) {
      return terminalNotice(error, acceptedBefore)
    }
  }

  const pace = async (signal: AbortSignal): Promise<boolean> => delay(SELECTOR_GROUP_DELAY_MS, signal)

  const sendPermission = async (
    session: Session,
    question: DockQuestion,
    answers: string[][],
    signal: AbortSignal
  ): Promise<{ confirmed: boolean; notice: string }> => {
    const selection = answers.length === 1 && Array.isArray(answers[0]) && answers[0].length === 1 ? answers[0][0] : null
    if (selection !== 'allow' && selection !== 'deny') return { confirmed: false, notice: 'Choose the provider permission action shown on the card.' }
    const key = selection === 'deny' ? ESCAPE : ['opencode', 'opencode2', 'zcode'].includes(session.agent) ? ENTER : '1'
    const signalForOperation = operationSignal(signal)
    const result = await writeAnswerStep(session, question, key, signalForOperation, false)
    if (result.accepted || result.uncertain) answered.add(question.id)
    if (result.notice) return { confirmed: false, notice: result.notice }
    return { confirmed: false, notice: 'Sent to the agent — not confirmed.' }
  }

  const answer = async (
    session: Session,
    question: DockQuestion,
    answers: string[][],
    signal: AbortSignal
  ): Promise<{ confirmed: boolean; notice: string }> => {
    if (disposed || signal.aborted) return { confirmed: false, notice: 'The answer was cancelled before terminal input.' }
    if (question.kind === 'permission') return sendPermission(session, question, answers, signal)
    if (answered.has(question.id)) return { confirmed: false, notice: 'This provider request has already been answered.' }
    const parsed = normalizeAnswers(question, answers)
    if (parsed.error) return { confirmed: false, notice: parsed.error }
    const signalForOperation = operationSignal(signal)
    if (['grok', 'omp'].includes(session.agent)) {
      const text = formatAnswerText(parsed.groups)
      const paste = `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`
      const body = await writeAnswerStep(session, question, paste, signalForOperation, false)
      if (body.notice) {
        if (body.accepted || body.uncertain) answered.add(question.id)
        return { confirmed: false, notice: body.notice }
      }
      if (!await delay(PASTE_SUBMIT_DELAY_MS, signalForOperation)) {
        answered.add(question.id)
        return { confirmed: false, notice: 'The answer paste was accepted, but submission was cancelled; check the terminal before retrying.' }
      }
      const submit = await writeAnswerStep(session, question, ENTER, signalForOperation, true)
      if (submit.accepted || submit.uncertain) answered.add(question.id)
      return { confirmed: false, notice: submit.notice ?? 'Sent to the agent — not confirmed.' }
    }
    const plan = questionSteps(session.agent, question, parsed.groups)
    if (plan.error) return { confirmed: false, notice: plan.error }
    if (plan.values.length === 0) return { confirmed: false, notice: 'No answer keys were generated for the active provider question.' }
    let accepted = false
    for (let index = 0; index < plan.values.length; index++) {
      if (signalForOperation.aborted || disposed) {
        if (accepted) answered.add(question.id)
        return { confirmed: false, notice: accepted ? 'The answer was cancelled after terminal input; check the terminal before retrying.' : 'The answer was cancelled before terminal input.' }
      }
      if (index > 0 && !await pace(signalForOperation)) {
        if (accepted) answered.add(question.id)
        return { confirmed: false, notice: accepted ? 'The answer was cancelled after terminal input; check the terminal before retrying.' : 'The answer was cancelled before terminal input.' }
      }
      const result = await writeAnswerStep(session, question, plan.values[index]!, signalForOperation, accepted)
      accepted ||= result.accepted
      if (result.notice) {
        if (accepted || result.uncertain) answered.add(question.id)
        return { confirmed: false, notice: result.notice }
      }
    }
    if (accepted) answered.add(question.id)
    return { confirmed: false, notice: 'Sent to the agent — not confirmed.' }
  }

  const validatePermissionOption = async (
    session: Session,
    value: string,
    signal: AbortSignal
  ): Promise<{ live: LiveState; screen: string | null; permission: PermissionEvidence } | { notice: string }> => {
    if (disposed || signal.aborted) return { notice: 'The permission change was cancelled.' }
    if (!SUPPORTED_AGENTS[session.agent]) return { notice: unsupportedPermissionNotice(session.agent) }
    const live = await liveState(session)
    if (!live.status) return { notice: 'Agent status is unavailable; refusing to change this session permission.' }
    if (live.status.state !== 'waiting') return { notice: 'Permission modes can change only while the agent is waiting at its input prompt.' }
    if (live.question && !answered.has(live.question.id)) {
      return { notice: 'Resolve the active provider question before changing session options.' }
    }
    const screen = await readScreen(session)
    if (screenOwnsApprovalInput(session.agent, screen)) {
      return { notice: 'An active question or approval selector owns terminal input; resolve it before changing permission modes.' }
    }
    const permission = permissionEvidence(session.agent, screen)
    if (!permission.choices.includes(value)) {
      if (permission.current && (session.agent === 'claude' || session.agent === 'openclaude')) {
        return { notice: `The requested mode is not in the safely observed ${session.agent} cycle; optional modes are not guessed.` }
      }
      if (session.agent === 'codex' && codexPermissionMenu(screen)) {
        return { notice: 'The requested Codex preset is not visible in the live /permissions picker.' }
      }
      return { notice: permission.notice ?? `The ${session.agent} session does not expose that permission choice.` }
    }
    return { live, screen, permission }
  }
  const validateOption = async (
    session: Session,
    kind: 'model' | 'effort',
    value: string,
    signal: AbortSignal
  ): Promise<{ live: LiveState; catalog: OptionCatalog } | { notice: string }> => {
    if (disposed || signal.aborted) return { notice: 'The option change was cancelled.' }
    if (!SUPPORTED_AGENTS[session.agent]) return { notice: 'This provider has no session-safe option controls.' }
    const live = await liveState(session)
    if (live.question && !answered.has(live.question.id)) {
      return { notice: 'Resolve the active provider question before changing session options.' }
    }
    const { catalog, error } = await readOptionCatalog(session)
    if (!catalog) return { notice: error ?? 'This provider has no public session-option catalog.' }
    const options = optionsFromEvidence(live.status, live.transcript, catalog)
    if (!options.choices[kind].includes(value)) return { notice: `The ${kind} choice is not in this session's provider catalog.` }
    return { live, catalog }
  }

  const optionConfirmation = async (
    session: Session,
    kind: 'model' | 'effort',
    value: string,
    label: string
  ): Promise<boolean> => {
    const after = await liveState(session)
    if (optionIsCurrent(kind, value, after)) return true
    const screen = await readScreen(session)
    return screen !== null && optionScreenConfirms(screen, kind, value, label)
  }

  const claudePermissionOption = async (
    session: Session,
    value: string,
    initiallyObserved: string,
    signal: AbortSignal
  ): Promise<{ confirmed: boolean; notice: string }> => {
    const safeSignal = operationSignal(signal)
    let current = initiallyObserved
    for (let step = 0; step < MAX_OPTION_NAVIGATION_STEPS; step++) {
      if (safeSignal.aborted || disposed) return { confirmed: false, notice: 'Permission mode change was cancelled.' }
      const live = await liveState(session)
      if (!live.status || live.status.state !== 'waiting' || (live.question && !answered.has(live.question.id))) {
        return { confirmed: false, notice: 'The agent is no longer waiting at an empty prompt; permission mode was not changed further.' }
      }
      const screen = await readScreen(session)
      if (!screen) return { confirmed: false, notice: 'Permission mode screen is unavailable; refusing to cycle blindly.' }
      if (screenOwnsApprovalInput(session.agent, screen)) {
        return { confirmed: false, notice: 'An active question or approval selector owns terminal input; refusing to cycle permission modes.' }
      }
      const observed = terminalPermissionMode(session.agent, screen)
      if (!observed) return { confirmed: false, notice: 'The current permission mode is not exactly visible; refusing to cycle blindly.' }
      if (observed === value) return { confirmed: true, notice: `Confirmed by the visible ${session.agent} permission status.` }
      if (observed !== current) return { confirmed: false, notice: `The ${session.agent} permission mode changed before the requested transition.` }
      if (!hasEmptyInputPrompt(screen)) return { confirmed: false, notice: 'The provider prompt is not empty; refusing to change permission mode.' }
      if (!safePermissionTargets(session.agent, observed).includes(value)) {
        return { confirmed: false, notice: 'The requested mode would require cycling through an optional or unobserved permission mode; refusing.' }
      }
      const allowedNext = safePermissionNext(session.agent, observed)
      if (allowedNext.length === 0) return { confirmed: false, notice: 'No safe next permission transition is evidenced from the current mode.' }
      try {
        await context.pty.writeAccepted(session.id, SHIFT_TAB)
      } catch (error) {
        return { confirmed: false, notice: terminalNotice(error, false).notice ?? 'The provider refused its session permission cycle.' }
      }
      if (!await delay(OPTION_DELAY_MS, safeSignal)) return { confirmed: false, notice: 'Permission mode change was cancelled after a cycle key; check the terminal.' }
      const afterScreen = await readScreen(session)
      const after = terminalPermissionMode(session.agent, afterScreen)
      if (!after) return { confirmed: false, notice: 'The cycle key was sent, but the resulting permission mode is not observable.' }
      if (after === value) return { confirmed: true, notice: `Confirmed by the visible ${session.agent} permission status.` }
      if (!allowedNext.includes(after)) {
        return { confirmed: false, notice: `The session moved to ${after}, outside the verified safe cycle; no further key was sent.` }
      }
      current = after
    }
    return { confirmed: false, notice: 'Permission mode traversal exceeded its safe step limit.' }
  }

  const codexPermissionOption = async (
    session: Session,
    value: string,
    signal: AbortSignal
  ): Promise<{ confirmed: boolean; notice: string }> => {
    const safeSignal = operationSignal(signal)
    if (safeSignal.aborted || disposed) return { confirmed: false, notice: 'Codex permission change was cancelled before terminal input.' }
    const waiting = async (): Promise<boolean> => {
      const live = await liveState(session)
      return !!live.status && live.status.state === 'waiting' && (!live.question || answered.has(live.question.id))
    }
    if (!await waiting()) return { confirmed: false, notice: 'Codex is not waiting at an empty prompt; refusing to open its permission picker.' }
    let screen = await readScreen(session)
    if (!screen) return { confirmed: false, notice: 'Codex screen is unavailable; refusing to change permissions.' }
    if (screenOwnsApprovalInput(session.agent, screen)) {
      return { confirmed: false, notice: 'An active question or approval selector owns terminal input; refusing to open /permissions.' }
    }
    let menu = codexPermissionMenu(screen)
    if (!menu) {
      if (!hasEmptyInputPrompt(screen)) return { confirmed: false, notice: 'Codex /permissions picker is not open and its prompt is not empty.' }
      if (safeSignal.aborted || disposed) return { confirmed: false, notice: 'Codex permission change was cancelled before its picker command.' }
      if (!await waiting()) return { confirmed: false, notice: 'Codex stopped waiting before its permission picker opened.' }
      try {
        await context.pty.writeAccepted(session.id, `/permissions${ENTER}`)
      } catch (error) {
        return { confirmed: false, notice: terminalNotice(error, false).notice ?? 'Codex refused its /permissions command.' }
      }
      if (!await delay(OPTION_DELAY_MS, safeSignal)) return { confirmed: false, notice: 'Codex permission picker opening was cancelled.' }
      if (!await waiting()) return { confirmed: false, notice: 'Codex started a turn while opening permissions; no selection key was sent.' }
      screen = await readScreen(session) ?? ''
      if (screenOwnsApprovalInput(session.agent, screen)) {
        return { confirmed: false, notice: 'An approval prompt opened instead of the permission preset picker.' }
      }
      menu = codexPermissionMenu(screen)
    }
    if (!menu) return { confirmed: false, notice: 'The Codex /permissions picker did not show a recognized preset list.' }
    let target = menu.choices.find((choice) => choice.value === value)
    if (!target) return { confirmed: false, notice: 'The requested Codex preset is not visible in the live /permissions picker.' }
    let rows = screenRows(screen)
    let selected = selectedRowIndex(rows)
    if (selected < 0 || !menu.choices.some((choice) => choice.row === selected)) {
      return { confirmed: false, notice: 'Codex current selection does not identify a visible permission preset.' }
    }
    let navigationSteps = 0
    while (selected !== target.row) {
      if (navigationSteps++ >= MAX_OPTION_NAVIGATION_STEPS) return { confirmed: false, notice: 'Codex permission navigation exceeded its safe limit.' }
      if (safeSignal.aborted || disposed) return { confirmed: false, notice: 'Codex permission selection was cancelled.' }
      if (!await waiting()) return { confirmed: false, notice: 'Codex stopped waiting; no further permission keys were sent.' }
      const freshScreen = await readScreen(session)
      if (!freshScreen) return { confirmed: false, notice: 'Codex screen became unavailable before permission navigation.' }
      if (screenOwnsApprovalInput(session.agent, freshScreen)) {
        return { confirmed: false, notice: 'An approval prompt took control before permission navigation.' }
      }
      const freshMenu = codexPermissionMenu(freshScreen)
      const freshTarget = freshMenu?.choices.find((choice) => choice.value === value)
      const freshRows = screenRows(freshScreen)
      const freshSelection = selectedRowIndex(freshRows)
      if (!freshMenu || !freshTarget || freshSelection < 0 || !freshMenu.choices.some((choice) => choice.row === freshSelection)) {
        return { confirmed: false, notice: 'The Codex permission picker changed before navigation.' }
      }
      screen = freshScreen
      menu = freshMenu
      target = freshTarget
      rows = freshRows
      selected = freshSelection
      if (selected === target.row) break
      const previousSelection = selected
      const key = selected < target.row ? DOWN : UP
      try {
        await context.pty.writeAccepted(session.id, key)
      } catch (error) {
        return { confirmed: false, notice: terminalNotice(error, false).notice ?? 'Codex refused permission picker navigation.' }
      }
      if (!await delay(OPTION_DELAY_MS, safeSignal)) return { confirmed: false, notice: 'Codex permission navigation was cancelled.' }
      screen = await readScreen(session) ?? ''
      if (screenOwnsApprovalInput(session.agent, screen)) {
        return { confirmed: false, notice: 'An approval prompt took control during permission navigation.' }
      }
      menu = codexPermissionMenu(screen)
      if (!menu) return { confirmed: false, notice: 'The Codex permission picker changed unexpectedly.' }
      target = menu.choices.find((choice) => choice.value === value)
      rows = screenRows(screen)
      selected = selectedRowIndex(rows)
      if (!target || selected < 0) return { confirmed: false, notice: 'The requested Codex preset is no longer visible.' }
      if (selected === previousSelection) return { confirmed: false, notice: 'Codex permission picker did not move.' }
    }
    if (!await waiting()) return { confirmed: false, notice: 'Codex stopped waiting before permission selection.' }
    screen = await readScreen(session) ?? ''
    if (screenOwnsApprovalInput(session.agent, screen)) {
      return { confirmed: false, notice: 'An approval prompt took control before permission selection.' }
    }
    menu = codexPermissionMenu(screen)
    target = menu?.choices.find((choice) => choice.value === value)
    rows = screenRows(screen)
    if (!menu || !target || selectedRowIndex(rows) !== target.row) {
      return { confirmed: false, notice: 'Codex permission selection changed before confirmation.' }
    }
    const selectedLabel = target.label
    if (safeSignal.aborted || disposed) return { confirmed: false, notice: 'Codex permission selection was cancelled before confirmation.' }
    try {
      await context.pty.writeAccepted(session.id, ENTER)
    } catch (error) {
      return { confirmed: false, notice: terminalNotice(error, false).notice ?? 'Codex refused the selected permission preset.' }
    }
    if (!await delay(OPTION_DELAY_MS, safeSignal)) return { confirmed: false, notice: 'Codex accepted Enter, but the active permission mode was not confirmed.' }
    const afterScreen = await readScreen(session)
    if (afterScreen && normalized(afterScreen).includes('permissionselectionrequested') &&
      normalized(afterScreen).includes(normalized(selectedLabel))) {
      return { confirmed: false, notice: 'Codex accepted the permission selection request; the active mode is not confirmed.' }
    }
    return { confirmed: false, notice: 'The Codex permission selection was sent, but the active mode is not confirmed.' }
  }

  const claudeOption = async (
    session: Session,
    kind: 'model' | 'effort',
    value: string,
    label: string,
    signal: AbortSignal
  ): Promise<{ confirmed: boolean; notice: string }> => {
    const safeSignal = operationSignal(signal)
    let screen = await readScreen(session)
    if (!screen) return { confirmed: false, notice: 'Claude screen is unavailable; refusing to change a session option.' }
    if (screenShowsPersistentConfirmation(screen)) return { confirmed: false, notice: 'A persistent-default confirmation is visible; refusing to press it.' }
    let rows = screenRows(screen)
    let targetIndex = targetRowIndex(rows, label)
    if (targetIndex < 0) {
      if (!/(?:^|\n)❯\s*$/m.test(stripAnsi(screen))) {
        return { confirmed: false, notice: 'Claude session-only picker is not visible; refusing to guess at a model or effort command.' }
      }
      try {
        await context.pty.writeAccepted(session.id, '/model\r')
      } catch (error) {
        return { confirmed: false, notice: terminalNotice(error, false).notice ?? 'Claude did not accept the picker command.' }
      }
      if (!await delay(OPTION_DELAY_MS, safeSignal)) return { confirmed: false, notice: 'Claude picker navigation was cancelled.' }
      screen = await readScreen(session) ?? ''
      if (screenShowsPersistentConfirmation(screen)) return { confirmed: false, notice: 'A persistent-default confirmation appeared; refusing to press it.' }
      rows = screenRows(screen)
      targetIndex = targetRowIndex(rows, label)
    }
    if (targetIndex < 0 || !/(?:model|effort)/i.test(screen)) {
      return { confirmed: false, notice: 'The expected Claude model or effort choice is not visible in its picker.' }
    }
    let selected = selectedRowIndex(rows)
    if (selected < 0) return { confirmed: false, notice: 'Claude picker selection is not observable; refusing to choose by position.' }
    let navigationSteps = 0
    while (selected !== targetIndex) {
      if (navigationSteps++ >= MAX_OPTION_NAVIGATION_STEPS) return { confirmed: false, notice: 'Claude picker navigation exceeded its safe limit.' }
      const previousSelection = selected
      if (safeSignal.aborted || disposed || screenShowsPersistentConfirmation(screen)) {
        return { confirmed: false, notice: 'Claude session-only picker navigation was cancelled or entered an unsafe confirmation.' }
      }
      const key = selected < targetIndex ? DOWN : UP
      try {
        await context.pty.writeAccepted(session.id, key)
      } catch (error) {
        return { confirmed: false, notice: terminalNotice(error, false).notice ?? 'Claude refused picker navigation.' }
      }
      if (!await delay(SELECTOR_GROUP_DELAY_MS, safeSignal)) return { confirmed: false, notice: 'Claude picker navigation was cancelled.' }
      screen = await readScreen(session) ?? ''
      if (screenShowsPersistentConfirmation(screen)) return { confirmed: false, notice: 'A persistent-default confirmation appeared; refusing to press it.' }
      rows = screenRows(screen)
      selected = selectedRowIndex(rows)
      targetIndex = targetRowIndex(rows, label)
      if (selected < 0 || targetIndex < 0) return { confirmed: false, notice: 'Claude picker changed unexpectedly; refusing to continue.' }
      if (selected === previousSelection) return { confirmed: false, notice: 'Claude picker did not move; refusing to continue.' }
    }
    if (!hasSessionOnlyAction(screen)) return { confirmed: false, notice: 'Claude did not display its session-only `s` action; refusing to save a default.' }
    if (safeSignal.aborted || disposed) return { confirmed: false, notice: 'Claude option change was cancelled.' }
    try {
      await context.pty.writeAccepted(session.id, 's')
    } catch (error) {
      return { confirmed: false, notice: terminalNotice(error, false).notice ?? 'Claude refused its session-only action.' }
    }
    const afterScreen = await readScreen(session)
    if (afterScreen && optionScreenConfirms(afterScreen, kind, value, label)) return { confirmed: true, notice: 'Confirmed by the Claude session screen.' }
    if (await optionConfirmation(session, kind, value, label)) return { confirmed: true, notice: 'Confirmed by current session evidence.' }
    return { confirmed: false, notice: 'Sent to the agent — not confirmed.' }
  }

  const providerPickerOption = async (
    session: Session,
    provider: 'Codex' | 'OMP',
    kind: 'model' | 'effort',
    value: string,
    label: string,
    command: string,
    signal: AbortSignal
  ): Promise<{ confirmed: boolean; notice: string }> => {
    const safeSignal = operationSignal(signal)
    let screen = await readScreen(session)
    if (!screen) return { confirmed: false, notice: `${provider} screen is unavailable; refusing to change a session option.` }
    let rows = screenRows(screen)
    let targetIndex = targetRowIndex(rows, label)
    if (targetIndex < 0) {
      if (!/(?:^|\n)\s*(?:❯|›|>)\s*$/m.test(stripAnsi(screen))) {
        return { confirmed: false, notice: `${provider} model picker is not visible; refusing to guess at a command.` }
      }
      try {
        await context.pty.writeAccepted(session.id, `${command}\r`)
      } catch (error) {
        return { confirmed: false, notice: terminalNotice(error, false).notice ?? `${provider} did not accept its model picker command.` }
      }
      if (!await delay(OPTION_DELAY_MS, safeSignal)) return { confirmed: false, notice: `${provider} picker navigation was cancelled.` }
      screen = await readScreen(session) ?? ''
      rows = screenRows(screen)
      targetIndex = targetRowIndex(rows, label)
    }
    if (targetIndex < 0 || !/model/i.test(screen)) return { confirmed: false, notice: `The expected ${provider} ${kind} choice is not visible.` }
    let selected = selectedRowIndex(rows)
    if (selected < 0) return { confirmed: false, notice: `${provider} picker selection is not observable; refusing to choose by position.` }
    let navigationSteps = 0
    while (selected !== targetIndex) {
      if (navigationSteps++ >= MAX_OPTION_NAVIGATION_STEPS) return { confirmed: false, notice: `${provider} picker navigation exceeded its safe limit.` }
      const previousSelection = selected
      if (safeSignal.aborted || disposed) return { confirmed: false, notice: `${provider} picker navigation was cancelled.` }
      const key = selected < targetIndex ? DOWN : UP
      try {
        await context.pty.writeAccepted(session.id, key)
      } catch (error) {
        return { confirmed: false, notice: terminalNotice(error, false).notice ?? `${provider} refused picker navigation.` }
      }
      if (!await delay(SELECTOR_GROUP_DELAY_MS, safeSignal)) return { confirmed: false, notice: `${provider} picker navigation was cancelled.` }
      screen = await readScreen(session) ?? ''
      rows = screenRows(screen)
      selected = selectedRowIndex(rows)
      targetIndex = targetRowIndex(rows, label)
      if (selected < 0 || targetIndex < 0) return { confirmed: false, notice: `${provider} picker changed unexpectedly; refusing to continue.` }
      if (selected === previousSelection) return { confirmed: false, notice: `${provider} picker did not move; refusing to continue.` }
    }
    if (safeSignal.aborted || disposed) return { confirmed: false, notice: `${provider} option change was cancelled.` }
    try {
      await context.pty.writeAccepted(session.id, ENTER)
    } catch (error) {
      return { confirmed: false, notice: terminalNotice(error, false).notice ?? `${provider} refused the selected option.` }
    }
    if (await optionConfirmation(session, kind, value, label)) return { confirmed: true, notice: 'Confirmed by current session evidence.' }
    return { confirmed: false, notice: 'Sent to the agent — not confirmed.' }
  }

  const grokOption = async (
    session: Session,
    kind: 'model' | 'effort',
    value: string,
    label: string,
    signal: AbortSignal
  ): Promise<{ confirmed: boolean; notice: string }> => {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) return { confirmed: false, notice: 'The Grok option value is not a safe provider catalog identifier.' }
    const command = `/${kind} ${value}`
    const safeSignal = operationSignal(signal)
    try {
      await context.pty.writeAccepted(session.id, `${BRACKETED_PASTE_START}${command}${BRACKETED_PASTE_END}`)
    } catch (error) {
      return { confirmed: false, notice: terminalNotice(error, false).notice ?? 'Grok refused the session option.' }
    }
    if (!await delay(PASTE_SUBMIT_DELAY_MS, safeSignal)) return { confirmed: false, notice: 'Grok option submission was cancelled after paste; check the terminal.' }
    if (safeSignal.aborted || disposed) return { confirmed: false, notice: 'Grok option submission was cancelled after paste; check the terminal.' }
    try {
      await context.pty.writeAccepted(session.id, ENTER)
    } catch (error) {
      return { confirmed: false, notice: terminalNotice(error, true).notice ?? 'Grok option submission may be incomplete.' }
    }
    if (await optionConfirmation(session, kind, value, label)) return { confirmed: true, notice: 'Confirmed by current session evidence.' }
    return { confirmed: false, notice: 'Sent to the agent — not confirmed.' }
  }

  const setOption = async (
    session: Session,
    kind: 'model' | 'effort' | 'permission',
    value: string,
    signal: AbortSignal
  ): Promise<{ confirmed: boolean; notice: string }> => {
    if (kind === 'permission') {
      const checked = await validatePermissionOption(session, value, signal)
      if ('notice' in checked) return { confirmed: false, notice: checked.notice }
      if (checked.permission.current === value) {
        return { confirmed: true, notice: `Confirmed by the visible ${session.agent} permission status.` }
      }
      if (session.agent === 'claude' || session.agent === 'openclaude') {
        if (!checked.permission.current) return { confirmed: false, notice: 'The current permission mode is not observable.' }
        return claudePermissionOption(session, value, checked.permission.current, signal)
      }
      if (session.agent === 'codex') return codexPermissionOption(session, value, signal)
      return { confirmed: false, notice: unsupportedPermissionNotice(session.agent) }
    }
    const checked = await validateOption(session, kind, value, signal)
    if ('notice' in checked) return { confirmed: false, notice: checked.notice }
    if (optionIsCurrent(kind, value, checked.live)) return { confirmed: true, notice: 'The session already reports this option.' }
    const label = optionLabel(checked.catalog, kind, value) ?? value
    if (session.agent === 'claude' || session.agent === 'openclaude') {
      return claudeOption(session, kind, value, label, signal)
    }
    if (session.agent === 'codex') return providerPickerOption(session, 'Codex', kind, value, label, '/model', signal)
    if (session.agent === 'omp') return providerPickerOption(session, 'OMP', kind, value, label, '/model', signal)
    if (session.agent === 'grok') return grokOption(session, kind, value, label, signal)
    return { confirmed: false, notice: `This ${session.agent} session does not expose a safe runtime ${kind} action.` }
  }

  const observed = async (session: Session, text: string, since: number): Promise<boolean> => {
    if (disposed || !text || !Number.isFinite(since) || session.status === 'exited') return false
    const { status } = await readStatus(session)
    const providerSession = status?.lead.providerSession ?? session.providerSession?.id ?? session.id
    if (status && status.source === 'hook' && status.restoredUnconfirmed !== true && !status.lead.ended &&
      status.lead.providerSession === providerSession && status.turnStartedAt !== null &&
      status.turnStartedAt >= since && status.prompt === text) return true
    const transcript = await withinDeadline(readProviderTranscript(session, providerSession), 3_000, 'Provider transcript lookup timed out.').catch(() => ({
      events: [],
      model: null,
      effort: null,
      context: null,
      modifiedAt: null,
      source: null,
      notice: 'Provider transcript lookup timed out.'
    }))
    return transcriptObserved(transcript, text, since)
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    disposeController.abort()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  return { read, answer, setOption, observed, dispose }
}
