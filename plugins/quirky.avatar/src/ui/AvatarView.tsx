import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Badge, Button, Checkbox, EmptyState, ListRow, SectionHeader, SegmentedControl, SelectField, Tabs, TextArea, TextField, ToolPanelFrame, type UiStatus } from '@quirky/ui'
import type { AskAnswer, AskOption, AskQuestion, UiPluginContext } from '@quirky/protocol'
import type { AvatarUiProps, JournalEntry, JournalKind, Level, Mandate, NeedAction, NeedsYouItem, ReportModel, SwitchId, WorktreeState } from '../contracts'
import DecisionTrace, { describeToolInput } from './DecisionTrace'

/** What `quirky.avatar/status` returns. */
export type StatusResult = { handoffs: { worktreeId: string; name: string; projectName?: string; state: WorktreeState; level: Level }[]; needsYouCount: number }

type Tab = 'live' | 'report' | 'log'

const CHANGED_EVENT = 'quirky.avatar/changed'
const LIVE_FEED_LIMIT = 30
const LOG_LIMIT = 100

const STATE_LABELS: Record<WorktreeState, string> = {
  checking: 'Checking',
  'gate-failed': 'Gate failed',
  briefing: 'Briefing',
  working: 'Working',
  'waiting-on-you': 'Waiting on you',
  'checking-done': 'Checking done',
  'in-review': 'In review',
  'merge-ready': 'Merge ready',
  merged: 'Merged',
  'pr-ready': 'PR ready',
  committed: 'Committed',
  parked: 'Parked',
  done: 'Done'
}

const LEVEL_LABELS: Record<Level, string> = { shadow: 'Shadow', local: 'Local', 'own-branch': 'Own branch', full: 'Full' }

const SWITCH_LABELS: Record<SwitchId, string> = { messaging: 'Messaging on', historyRewrite: 'History rewrites on', deploys: 'Deploys on' }

const ACTION_LABELS: Record<NeedAction, string> = {
  'allow-once': 'Allow once',
  deny: 'Deny',
  confirm: 'Confirm',
  redo: 'Redo',
  'review-accept': 'Accept edit',
  'review-reject': 'Reject edit',
  answer: 'Answer',
  restart: 'Restart',
  'take-back': 'Take back',
  'restart-to-handoff': 'Restart to hand off'
}

const KIND_LABELS: Record<JournalKind, string> = {
  handoff: 'Handed off',
  'take-back': 'Taken back',
  gate: 'Gate decision',
  event: 'Event',
  'brain-action': 'Avatar action',
  'brain-error': 'Avatar error',
  rotation: 'Rotation',
  ask: 'Question',
  guess: 'Guess',
  stuck: 'Stuck',
  ladder: 'Recovery step',
  'done-check': 'Done check',
  finding: 'Review finding',
  outbox: 'Outbound action',
  'skipped-call': 'Call without the gate',
  sleep: 'Mac slept',
  'mandate-proposal': 'Mandate proposal',
  notify: 'Notification'
}

const EVENT_LABELS: Record<string, string> = {
  state: 'State changed',
  'gate-check': 'Gate check',
  'gate-check-error': 'Gate check error',
  'brief-not-sent': 'Brief not sent',
  'start-failed': 'Agent failed to start',
  'send-failed': 'Message not sent',
  'restart-failed': 'Restart failed',
  progress: 'Progress',
  'step-in': 'Stepped in',
  'step-in-refused': 'Step-in refused',
  'skipped-call-error': 'Skipped-call check failed',
  'ask-resolved': 'Question answered'
}

const OUTCOME_LABELS: Record<string, string> = { allow: 'Allowed', deny: 'Denied', held: 'Held', retry: 'Asked to retry', passthrough: 'Passed through' }

/** `Project / worktree`, so same-named worktrees in different projects stay apart. */
export const worktreeLabel = (name: string, projectName?: string): string => (projectName === undefined || projectName === '' || projectName === name ? name : `${projectName} / ${name}`)

/** A kind-like id ("session-start-failed") as a sentence fragment ("session start failed"). */
const humanize = (value: string): string => (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(value) ? value.replaceAll('-', ' ') : value)

export const stateLabel = (state: WorktreeState): string => STATE_LABELS[state]
export const levelLabel = (level: Level): string => LEVEL_LABELS[level]

/** Maps a worktree state to the status dot the shared list rows draw. */
export function uiStatusOf(state: WorktreeState): UiStatus {
  switch (state) {
    case 'waiting-on-you':
    case 'parked':
      return 'needs-you'
    case 'gate-failed':
      return 'failing'
    case 'merge-ready':
    case 'merged':
    case 'pr-ready':
    case 'committed':
    case 'done':
      return 'done'
    default:
      return 'working'
  }
}

export const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * Calls `quirky.avatar/<method>` on mount and again on every `quirky.avatar/changed` event.
 * A reply that arrives after a newer request, or after unmount, is dropped; a failed refresh keeps
 * the last good data and reports the error.
 */
export function useAvatarQuery<T>(context: UiPluginContext, method: string, params: Record<string, unknown> = {}) {
  const key = JSON.stringify(params)
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null })
  const generation = useRef(0)

  const refresh = useCallback(() => {
    const mine = ++generation.current
    context.call(`quirky.avatar/${method}`, JSON.parse(key) as Record<string, unknown>).then(
      (data) => {
        if (mine === generation.current) setState({ data: data as T, error: null })
      },
      (cause: unknown) => {
        if (mine === generation.current) setState((previous) => ({ data: previous.data, error: messageOf(cause) }))
      }
    )
  }, [context, method, key])

  useEffect(() => {
    refresh()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === CHANGED_EVENT) refresh()
    })
    return () => {
      generation.current += 1
      unsubscribe()
    }
  }, [context, refresh])

  return { ...state, refresh }
}

const timeOf = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const DETAIL_KEYS = ['summary', 'message', 'title', 'reason', 'error', 'note']

function detailOf(data: Record<string, unknown>): string | null {
  for (const key of DETAIL_KEYS) {
    const value = data[key]
    if (typeof value === 'string' && value !== '') return humanize(value)
  }
  return null
}

function describeEvent(data: Record<string, unknown>): string {
  const type = typeof data.type === 'string' ? data.type : null
  if (type === 'state') {
    const to = typeof data.state === 'string' && data.state in STATE_LABELS ? STATE_LABELS[data.state as WorktreeState] : data.state
    const from = typeof data.from === 'string' && data.from in STATE_LABELS ? STATE_LABELS[data.from as WorktreeState] : null
    if (typeof to === 'string') return `State changed: ${from === null ? '' : `${from} → `}${to}`
  }
  if (type === 'gate-check' && typeof data.ok === 'boolean') return data.ok ? 'Gate check passed' : `Gate check failed${detailOf(data) === null ? '' : `: ${detailOf(data)}`}`
  const label = type === null ? (data.flakyRerun === true ? 'Flaky checks rerun' : data.checksGreen === true ? 'Checks passed' : 'Event') : (EVENT_LABELS[type] ?? humanize(type).replace(/^./, (first) => first.toUpperCase()))
  const detail = detailOf(data)
  return detail === null ? label : `${label}: ${detail}`
}

function describeEntry(entry: JournalEntry): string {
  const { data } = entry
  if (entry.kind === 'gate') {
    const outcome = typeof data.outcome === 'string' ? (OUTCOME_LABELS[data.outcome] ?? data.outcome) : 'Decided'
    const tool = typeof data.toolName === 'string' ? data.toolName : 'a call'
    const input = data.toolInput === undefined ? '' : describeToolInput(data.toolInput)
    return `${outcome} ${tool}${input === '' ? '' : `: ${input}`}`
  }
  if (entry.kind === 'event') return describeEvent(data)
  const detail = detailOf(data)
  return detail === null ? KIND_LABELS[entry.kind] : `${KIND_LABELS[entry.kind]}: ${detail}`
}

function nameMap(status: StatusResult | null, report: ReportModel | null): Map<string, string> {
  const names = new Map<string, string>()
  for (const handoff of status?.handoffs ?? []) names.set(handoff.worktreeId, worktreeLabel(handoff.name, handoff.projectName))
  for (const story of report?.stories ?? []) names.set(story.worktreeId, worktreeLabel(story.name, story.projectName))
  for (const need of report?.needsYou ?? []) if (!names.has(need.worktreeId)) names.set(need.worktreeId, worktreeLabel(need.worktreeName ?? need.worktreeId, need.projectName))
  return names
}

/** Resets the browser's list bullets and indent so each entry is just its card. */
const LIST_STYLE: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 }

function Failure({ message }: { message: string | null }) {
  return message === null ? null : <p role="alert">{message}</p>
}

function LiveTab({ context }: { context: UiPluginContext }) {
  const status = useAvatarQuery<StatusResult>(context, 'status')
  const log = useAvatarQuery<JournalEntry[]>(context, 'log', { limit: LIVE_FEED_LIMIT })
  const [failure, setFailure] = useState<string | null>(null)
  const entries = log.data ?? []
  const names = nameMap(status.data, null)

  const takeBack = async (worktreeId: string) => {
    setFailure(null)
    try {
      await context.call('quirky.avatar/takeBack', { worktreeIds: [worktreeId] })
    } catch (cause) {
      setFailure(messageOf(cause))
    }
    status.refresh()
  }

  const handoffs = status.data?.handoffs ?? []
  return (
    <div role="tabpanel" aria-label="Live">
      <Failure message={failure ?? status.error ?? log.error} />
      {handoffs.length === 0 ? (
        <EmptyState message="Nothing handed off." />
      ) : (
        handoffs.map((handoff) => {
          const latest = entries.find((entry) => entry.worktreeId === handoff.worktreeId)
          return (
            <ListRow
              key={handoff.worktreeId}
              title={worktreeLabel(handoff.name, handoff.projectName)}
              description={`${stateLabel(handoff.state)} · ${levelLabel(handoff.level)}${latest ? ` · ${describeEntry(latest)} · ${timeOf(latest.at)}` : ''}`}
              status={uiStatusOf(handoff.state)}
              trailing={
                <Button aria-label={`Take back ${handoff.name}`} onClick={() => void takeBack(handoff.worktreeId)}>
                  Take back
                </Button>
              }
            />
          )
        })
      )}
      <SectionHeader title="Live" />
      {entries.length === 0 ? (
        <p>No activity yet.</p>
      ) : (
        <ul style={LIST_STYLE}>
          {entries.map((entry) => (
            <li key={entry.seq}>{`${timeOf(entry.at)} · ${entry.worktreeId === null ? 'all' : (names.get(entry.worktreeId) ?? entry.worktreeId)} · ${describeEntry(entry)}`}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

type MandateLookup = { status: 'loading' } | { status: 'loaded'; mandate: Mandate } | { status: 'missing' } | { status: 'error' }
type MandatePatchField = 'goal' | 'doneWhen' | 'guidelines' | 'notes'

const PATCH_FIELD_LABELS: Record<MandatePatchField, string> = {
  goal: 'Goal',
  doneWhen: 'Done when',
  guidelines: 'Guidelines',
  notes: 'Notes'
}

const EMPTY_QUESTION_DRAFT: QuestionDraft = { selected: [], freeText: '', text: '', confirm: null }
const QUESTION_STACK_STYLE: CSSProperties = { display: 'grid', gap: 'var(--ui-space-12)' }
const QUESTION_FIELD_ROW_STYLE: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 'var(--ui-space-8)' }
const QUESTION_FIELD_STYLE: CSSProperties = { flex: 1, minWidth: 0 }
const QUESTION_LABEL_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 'var(--ui-space-8)', marginBottom: 'var(--ui-space-4)' }
const FIELD_GROUP_STYLE: CSSProperties = { display: 'grid', gap: 'var(--ui-space-8)' }
const CONFIRM_GROUP_STYLE: CSSProperties = { display: 'grid', gap: 'var(--ui-space-4)' }

type QuestionDraft = { selected: string[]; freeText: string; text: string; confirm: boolean | null }
type QuestionAnswerBuild = { ok: true; answers: Record<string, AskAnswer> } | { ok: false }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isAskOption(value: unknown): value is AskOption {
  if (!isPlainRecord(value) || typeof value.value !== 'string' || value.value.trim() === '' || typeof value.label !== 'string' || value.label.trim() === '') return false
  if (value.description !== undefined && typeof value.description !== 'string') return false
  if (value.preview !== undefined) {
    if (!isPlainRecord(value.preview) || (value.preview.format !== 'markdown' && value.preview.format !== 'html') || typeof value.preview.content !== 'string') return false
  }
  return true
}

function readQuestion(raw: unknown): { ok: true; question: AskQuestion } | { ok: false } {
  if (!isPlainRecord(raw) || typeof raw.id !== 'string' || raw.id.trim() === '' || typeof raw.question !== 'string' || raw.question.trim() === '') return { ok: false }
  if (raw.header !== undefined && typeof raw.header !== 'string') return { ok: false }
  if (raw.required !== undefined && typeof raw.required !== 'boolean') return { ok: false }
  switch (raw.type) {
    case 'select':
      if (!Array.isArray(raw.options) || raw.options.length === 0 || !raw.options.every(isAskOption)) return { ok: false }
      if (raw.default !== undefined && typeof raw.default !== 'string') return { ok: false }
      break
    case 'multiselect':
      if (!Array.isArray(raw.options) || raw.options.length === 0 || !raw.options.every(isAskOption)) return { ok: false }
      if (raw.default !== undefined && (!Array.isArray(raw.default) || !raw.default.every((value) => typeof value === 'string'))) return { ok: false }
      break
    case 'text':
      if (raw.multiline !== undefined && typeof raw.multiline !== 'boolean') return { ok: false }
      if (raw.pattern !== undefined && typeof raw.pattern !== 'string') return { ok: false }
      if (raw.format !== undefined && raw.format !== 'email' && raw.format !== 'url') return { ok: false }
      if (raw.default !== undefined && typeof raw.default !== 'string') return { ok: false }
      break
    case 'number':
      if (raw.integer !== undefined && typeof raw.integer !== 'boolean') return { ok: false }
      if (raw.min !== undefined && (typeof raw.min !== 'number' || !Number.isFinite(raw.min))) return { ok: false }
      if (raw.max !== undefined && (typeof raw.max !== 'number' || !Number.isFinite(raw.max))) return { ok: false }
      if (raw.default !== undefined && (typeof raw.default !== 'number' || !Number.isFinite(raw.default))) return { ok: false }
      break
    case 'date':
      if (raw.default !== undefined && typeof raw.default !== 'string') return { ok: false }
      break
    case 'confirm':
      if (raw.default !== undefined && typeof raw.default !== 'boolean') return { ok: false }
      break
    default:
      return { ok: false }
  }
  return { ok: true, question: raw as unknown as AskQuestion }
}

function formatMandateValue(value: string | string[]): string {
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.join('; ')
  return value === '' ? 'none' : value
}

function patchLinesOf(need: NeedsYouItem, lookup: MandateLookup): { field: MandatePatchField; line: string }[] {
  const patch = need.detail.patch
  if (!isPlainRecord(patch)) return []
  return (Object.keys(PATCH_FIELD_LABELS) as MandatePatchField[]).flatMap((field) => {
    const value = patch[field]
    if (value === undefined) return []
    const after = field === 'guidelines'
      ? (Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? formatMandateValue(value) : null)
      : (typeof value === 'string' ? formatMandateValue(value) : null)
    if (after === null) return []
    const before = lookup.status === 'loading' ? 'loading…'
      : lookup.status === 'error' ? 'unavailable'
        : lookup.status === 'missing' ? 'no mandate'
          : formatMandateValue(lookup.mandate[field])
    return [{ field, line: `${PATCH_FIELD_LABELS[field]}: ${before} → ${after}` }]
  })
}

function questionAnswersOf(questions: AskQuestion[], drafts: Map<string, QuestionDraft>): QuestionAnswerBuild {
  const entries: [string, AskAnswer][] = []
  let valid = true
  for (const question of questions) {
    const draft = drafts.get(question.id) ?? EMPTY_QUESTION_DRAFT
    const required = question.required === true
    switch (question.type) {
      case 'select': {
        const note = draft.freeText.trim()
        const picked = question.options.find((option) => option.value === draft.selected[0])
        if (picked) entries.push([question.id, { value: picked.value, label: picked.label, ...(note ? { note } : {}), source: 'option' }])
        else if (note) entries.push([question.id, { value: note, source: 'other' }])
        else if (required) valid = false
        break
      }
      case 'multiselect': {
        const other = draft.freeText.trim()
        const picked = question.options.filter((option) => draft.selected.includes(option.value))
        if (picked.length === 0 && !other) {
          if (required) valid = false
          break
        }
        entries.push([question.id, {
          values: picked.map((option) => option.value),
          labels: picked.map((option) => option.label),
          ...(other ? { other } : {}),
          source: 'options'
        }])
        break
      }
      case 'text':
        if (draft.text.trim() === '') {
          if (required) valid = false
        } else entries.push([question.id, { value: draft.text, source: 'input' }])
        break
      case 'number': {
        const raw = draft.text.trim()
        if (raw === '') {
          if (required) valid = false
          break
        }
        const value = Number(raw)
        if (!Number.isFinite(value) || (question.integer === true && !Number.isInteger(value)) || (question.min !== undefined && value < question.min) || (question.max !== undefined && value > question.max)) {
          valid = false
          break
        }
        entries.push([question.id, { value, source: 'input' }])
        break
      }
      case 'date':
        if (draft.text.trim() === '') {
          if (required) valid = false
        } else entries.push([question.id, { value: draft.text.trim(), source: 'input' }])
        break
      case 'confirm':
        if (draft.confirm === null) {
          if (required) valid = false
        } else entries.push([question.id, { value: draft.confirm, source: 'input' }])
        break
    }
  }
  return valid ? { ok: true, answers: Object.fromEntries(entries) } : { ok: false }
}

function QuestionControl({ question, draft, disabled, onChange }: {
  question: AskQuestion
  draft: QuestionDraft
  disabled: boolean
  onChange(patch: Partial<QuestionDraft>): void
}) {
  const optional = question.required === true ? null : <Badge>(optional)</Badge>
  switch (question.type) {
    case 'select':
      return (
        <div style={QUESTION_FIELD_ROW_STYLE}>
          <div style={QUESTION_FIELD_STYLE}>
            <SelectField label={question.question} value={draft.selected[0] ?? ''} disabled={disabled} onChange={(event) => onChange({ selected: event.target.value === '' ? [] : [event.target.value] })}>
              <option value="">Choose…</option>
              {question.options.map((option) => <option key={option.value} value={option.value}>{option.description ? `${option.label} — ${option.description}` : option.label}</option>)}
            </SelectField>
          </div>
          {optional}
          <TextField label="Add your own answer" value={draft.freeText} disabled={disabled} onChange={(event) => onChange({ freeText: event.target.value })} />
        </div>
      )
    case 'multiselect':
      return (
        <div style={FIELD_GROUP_STYLE}>
          <div style={QUESTION_LABEL_STYLE}>
            <span>{question.question}</span>
            {optional}
          </div>
          <div style={QUESTION_STACK_STYLE}>
            {question.options.map((option) => (
              <Checkbox
                key={option.value}
                label={option.label}
                checked={draft.selected.includes(option.value)}
                onChange={(checked) => onChange({ selected: checked ? [...draft.selected, option.value] : draft.selected.filter((value) => value !== option.value) })}
              />
            ))}
          </div>
          <TextField label="Add your own answer" value={draft.freeText} disabled={disabled} onChange={(event) => onChange({ freeText: event.target.value })} />
        </div>
      )
    case 'text': {
      const help = [
        question.format ? `Format: ${question.format}` : '',
        question.pattern ? `Pattern: ${question.pattern}` : ''
      ].filter(Boolean).join(' · ') || undefined
      const field = question.multiline === true
        ? <TextArea label={question.question} help={help} rows={3} value={draft.text} disabled={disabled} onChange={(event) => onChange({ text: event.target.value })} />
        : <TextField label={question.question} help={help} value={draft.text} disabled={disabled} onChange={(event) => onChange({ text: event.target.value })} />
      return <div style={QUESTION_FIELD_ROW_STYLE}><div style={QUESTION_FIELD_STYLE}>{field}</div>{optional}</div>
    }
    case 'number': {
      const hints = [
        question.integer === true ? 'Whole number' : '',
        question.min !== undefined && question.max !== undefined ? `${question.min} to ${question.max}`
          : question.min !== undefined ? `At least ${question.min}`
            : question.max !== undefined ? `At most ${question.max}` : ''
      ].filter(Boolean)
      return (
        <div style={QUESTION_FIELD_ROW_STYLE}>
          <div style={QUESTION_FIELD_STYLE}>
            <TextField
              label={question.question}
              type="number"
              step={question.integer === true ? 1 : 'any'}
              min={question.min}
              max={question.max}
              help={hints.join(' · ') || undefined}
              value={draft.text}
              disabled={disabled}
              onChange={(event) => onChange({ text: event.target.value })}
            />
          </div>
          {optional}
        </div>
      )
    }
    case 'date':
      return (
        <div style={QUESTION_FIELD_ROW_STYLE}>
          <div style={QUESTION_FIELD_STYLE}>
            <TextField label={question.question} type="date" help="YYYY-MM-DD" value={draft.text} disabled={disabled} onChange={(event) => onChange({ text: event.target.value })} />
          </div>
          {optional}
        </div>
      )
    case 'confirm':
      return (
        <div style={CONFIRM_GROUP_STYLE}>
          <div style={QUESTION_LABEL_STYLE}>
            <span>{question.question}</span>
            {optional}
          </div>
          <SegmentedControl
            label={question.question}
            options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]}
            value={draft.confirm === null ? null : String(draft.confirm)}
            onChange={(value) => onChange({ confirm: value === 'true' })}
          />
        </div>
      )
  }
}

function NeedRow({ need, worktreeName, mandateLookup = { status: 'loading' }, busy, onResolve }: {
  need: NeedsYouItem
  worktreeName: string
  mandateLookup?: MandateLookup
  busy: boolean
  onResolve(action: NeedAction, payload?: { text?: string; answers?: Record<string, AskAnswer> }): void
}) {
  const [legacyAnswer, setLegacyAnswer] = useState('')
  const [drafts, setDrafts] = useState<Map<string, QuestionDraft>>(() => new Map())
  const rawQuestions = need.detail.questions
  const legacyQuestions = rawQuestions === undefined || (Array.isArray(rawQuestions) && rawQuestions.length === 0)
  const questionResults = Array.isArray(rawQuestions) ? rawQuestions.map(readQuestion) : []
  const unreadableQuestions = !legacyQuestions && (!Array.isArray(rawQuestions) || questionResults.some((result) => !result.ok))
  const questions = unreadableQuestions ? [] : questionResults.flatMap((result) => result.ok ? [result.question] : [])
  const answerBuild = legacyQuestions || unreadableQuestions ? null : questionAnswersOf(questions, drafts)
  const patchLines = need.kind === 'mandate-edit' ? patchLinesOf(need, mandateLookup) : []
  const detailParts = [worktreeName]
  if (need.kind === 'guess') {
    const question = typeof need.detail.question === 'string' ? need.detail.question : ''
    const choice = typeof need.detail.choice === 'string' ? need.detail.choice : ''
    if (question !== '' && !need.title.includes(question)) detailParts.push(question)
    if (choice !== '') detailParts.push(`Chose: ${choice}`)
  } else if (need.kind === 'mandate-edit') {
    const why = need.detail.why
    if (typeof why === 'string' && why !== '') detailParts.push(why)
  } else {
    const detail = ['reason', 'question', 'summary', 'why'].map((key) => need.detail[key]).find((value): value is string => typeof value === 'string' && value !== '')
    if (detail) detailParts.push(detail)
  }
  const blocks = typeof need.detail.blocks === 'string' && need.detail.blocks !== '' ? `Blocks: ${need.detail.blocks}` : ''
  const canAnswer = legacyQuestions
    ? legacyAnswer.trim() !== ''
    : !unreadableQuestions && answerBuild?.ok === true

  const updateDraft = (questionId: string, patch: Partial<QuestionDraft>) => {
    setDrafts((previous) => {
      const next = new Map(previous)
      const current = next.get(questionId) ?? EMPTY_QUESTION_DRAFT
      next.set(questionId, { ...current, ...patch })
      return next
    })
  }

  const resolve = (action: NeedAction) => {
    if (action !== 'answer') {
      onResolve(action)
    } else if (legacyQuestions) {
      onResolve(action, { text: legacyAnswer.trim() })
    } else if (answerBuild?.ok) {
      onResolve(action, { answers: answerBuild.answers })
    }
  }

  return (
    <ListRow
      title={need.title}
      description={
        <div style={FIELD_GROUP_STYLE}>
          <span>{detailParts.filter(Boolean).join(' · ')}</span>
          {patchLines.map(({ field, line }) => <span key={field}>{line}</span>)}
          {blocks && <span>{blocks}</span>}
          {need.actions.includes('answer') && (
            <div style={QUESTION_STACK_STYLE}>
              {legacyQuestions ? (
                <TextField label="Your answer" value={legacyAnswer} disabled={busy} onChange={(event) => setLegacyAnswer(event.target.value)} />
              ) : unreadableQuestions ? (
                <Badge tone="failing">Question cannot be read</Badge>
              ) : questions.map((question) => (
                <QuestionControl
                  key={question.id}
                  question={question}
                  draft={drafts.get(question.id) ?? EMPTY_QUESTION_DRAFT}
                  disabled={busy}
                  onChange={(patch) => updateDraft(question.id, patch)}
                />
              ))}
            </div>
          )}
        </div>
      }
      status="needs-you"
      trailing={
        <>
          {need.actions.map((action, index) => (
            <Button
              key={action}
              variant={index === 0 ? 'primary' : 'secondary'}
              disabled={busy || (action === 'answer' && !canAnswer)}
              onClick={() => resolve(action)}
            >
              {ACTION_LABELS[action]}
            </Button>
          ))}
        </>
      }
    />
  )
}

function summaryLine(summary: ReportModel['summary']): string {
  const parts = [`${summary.decisions} decisions: ${summary.allowed} allowed, ${summary.denied} denied, ${summary.held} held, ${summary.guesses} guesses.`]
  if (summary.sleeps.length > 0) {
    const minutes = Math.max(1, Math.round(summary.sleeps.reduce((total, sleep) => total + sleep.durationMs, 0) / 60_000))
    parts.push(`The Mac slept ${summary.sleeps.length === 1 ? 'once' : `${summary.sleeps.length} times`} for ${minutes} min.`)
  }
  if (summary.keptAwake) parts.push('Mac kept awake.')
  return parts.join(' ')
}

function ReportTab({ context, onOpenLog }: { context: UiPluginContext; onOpenLog(): void }) {
  const { data, error, refresh } = useAvatarQuery<ReportModel>(context, 'report')
  const [busyNeeds, setBusyNeeds] = useState<ReadonlySet<string>>(() => new Set())
  const inFlightNeeds = useRef(new Set<string>())
  const [failure, setFailure] = useState<string | null>(null)
  const [mandates, setMandates] = useState<Record<string, MandateLookup>>({})
  const names = nameMap(null, data)
  const mandateWorktrees = [...new Set((data?.needsYou ?? []).filter((need) => need.kind === 'mandate-edit').map((need) => need.worktreeId))]

  useEffect(() => {
    let active = true
    if (mandateWorktrees.length === 0) setMandates({})
    else {
      setMandates((previous) => ({
        ...previous,
        ...Object.fromEntries(mandateWorktrees.map((worktreeId) => [worktreeId, Object.hasOwn(previous, worktreeId) ? previous[worktreeId] : { status: 'loading' as const }]))
      }))
      for (const worktreeId of mandateWorktrees) {
        void (async () => {
          try {
            const result = await context.call('quirky.avatar/mandate', { worktreeId })
            if (!active) return
            const lookup: MandateLookup = result === null
              ? { status: 'missing' }
              : { status: 'loaded', mandate: result as Mandate }
            setMandates((previous) => ({ ...previous, [worktreeId]: lookup }))
          } catch {
            if (active) setMandates((previous) => ({ ...previous, [worktreeId]: { status: 'error' } }))
          }
        })()
      }
    }
    return () => { active = false }
  }, [context, data])

  const resolve = async (needId: string, action: NeedAction, payload?: { text?: string; answers?: Record<string, AskAnswer> }) => {
    if (inFlightNeeds.current.has(needId)) return
    inFlightNeeds.current.add(needId)
    setBusyNeeds((previous) => new Set(previous).add(needId))
    setFailure(null)
    try {
      const result = (await context.call('quirky.avatar/resolveNeed', {
        needId,
        action,
        ...(payload?.text !== undefined ? { text: payload.text } : {}),
        ...(payload?.answers !== undefined ? { answers: payload.answers } : {})
      })) as { ok: boolean; error?: string }
      if (!result.ok) setFailure(result.error ?? 'The avatar could not apply that answer.')
    } catch (cause) {
      setFailure(messageOf(cause))
    } finally {
      inFlightNeeds.current.delete(needId)
      setBusyNeeds((previous) => {
        const next = new Set(previous)
        next.delete(needId)
        return next
      })
      refresh()
    }
  }

  if (data === null) return <div role="tabpanel" aria-label="Report"><Failure message={error} /></div>
  const count = data.needsYou.length
  return (
    <div role="tabpanel" aria-label="Report">
      <Failure message={failure ?? error} />
      <SectionHeader title={count === 0 ? 'Nothing needs you' : `${count} ${count === 1 ? 'thing needs' : 'things need'} you`} />
      {data.topSkippedCalls.map((entry) => (
        <ListRow
          key={`skipped-${entry.seq}`}
          title={`A call ran without the gate: ${describeEntry(entry)}`}
          description={`${entry.worktreeId === null ? 'all' : (names.get(entry.worktreeId) ?? entry.worktreeId)} · ${timeOf(entry.at)}`}
          status="failing"
        />
      ))}
      {data.needsYou.map((need) => (
        <NeedRow
          key={need.id}
          need={need}
          worktreeName={names.get(need.worktreeId) ?? need.worktreeId}
          mandateLookup={Object.prototype.hasOwnProperty.call(mandates, need.worktreeId) ? mandates[need.worktreeId] : undefined}
          busy={busyNeeds.has(need.id)}
          onResolve={(action, payload) => void resolve(need.id, action, payload)}
        />
      ))}
      <SectionHeader title="While you were away" />
      {data.stories.length === 0 ? (
        <p>Nothing handed off.</p>
      ) : (
        data.stories.map((story) => (
          <ListRow
            key={story.worktreeId}
            title={worktreeLabel(story.name, story.projectName)}
            description={
              <>
                {story.switchesOn.map((id) => (
                  <Badge key={id} tone="accent">{SWITCH_LABELS[id]}</Badge>
                ))}
                <span>{[story.story, story.handedBackWith.length > 0 ? `Handed back with: ${story.handedBackWith.join(', ')}` : ''].filter(Boolean).join(' ')}</span>
              </>
            }
          />
        ))
      )}
      <p>{summaryLine(data.summary)}</p>
      <Button onClick={onOpenLog}>Open decision log →</Button>
    </div>
  )
}

function LogEntryRow({ entry, worktreeName }: { entry: JournalEntry; worktreeName: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li>
      <ListRow
        compact
        title={describeEntry(entry)}
        description={`${timeOf(entry.at)} · ${worktreeName}`}
        trailing={
          entry.kind === 'gate' ? (
            <Button aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide trace' : 'Show trace'}</Button>
          ) : undefined
        }
      />
      {open && <DecisionTrace entry={entry} />}
    </li>
  )
}

type AvatarLogState = { entries: JournalEntry[]; reachedStart: boolean; error: string | null }

function joinNewestLogPage(previous: AvatarLogState, page: JournalEntry[]): AvatarLogState {
  const newestShown = previous.entries[0]
  if (!newestShown || !page.some((entry) => entry.seq === newestShown.seq)) {
    return { entries: page, reachedStart: page.length < LOG_LIMIT, error: null }
  }

  const oldestPageSeq = page[page.length - 1]!.seq
  return {
    entries: [...page, ...previous.entries.filter((entry) => entry.seq < oldestPageSeq)],
    reachedStart: previous.reachedStart,
    error: null
  }
}

function useAvatarLog(context: UiPluginContext) {
  const [state, setState] = useState<AvatarLogState>({ entries: [], reachedStart: false, error: null })
  const latestState = useRef(state)
  const lifecycle = useRef(0)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const update = useCallback((change: (previous: AvatarLogState) => AvatarLogState) => {
    const next = change(latestState.current)
    latestState.current = next
    setState(next)
  }, [])

  useEffect(() => {
    const scope = ++lifecycle.current
    let generation = 0
    const refresh = () => {
      const mine = ++generation
      context.call('quirky.avatar/log', { limit: LOG_LIMIT }).then(
        (data) => {
          if (lifecycle.current !== scope || mine !== generation) return
          update((previous) => joinNewestLogPage(previous, data as JournalEntry[]))
        },
        (cause: unknown) => {
          if (lifecycle.current !== scope || mine !== generation) return
          update((previous) => ({ ...previous, error: messageOf(cause) }))
        }
      )
    }

    refresh()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === CHANGED_EVENT) refresh()
    })
    return () => {
      generation++
      lifecycle.current++
      unsubscribe()
    }
  }, [context, update])

  const loadOlder = useCallback(async () => {
    if (loadingOlder) return
    const previous = latestState.current
    const before = previous.entries[previous.entries.length - 1]?.seq
    if (before === undefined || previous.reachedStart) return
    const scope = lifecycle.current
    setLoadingOlder(true)
    try {
      const page = await context.call('quirky.avatar/log', { limit: LOG_LIMIT, before }) as JournalEntry[]
      if (lifecycle.current !== scope) return
      update((current) => {
        if (current.entries[current.entries.length - 1]?.seq !== before) return current
        return {
          entries: [...current.entries, ...page],
          reachedStart: page.length < LOG_LIMIT,
          error: null
        }
      })
    } catch (cause) {
      if (lifecycle.current !== scope) return
      update((current) => ({ ...current, error: messageOf(cause) }))
    } finally {
      if (lifecycle.current === scope) setLoadingOlder(false)
    }
  }, [context, loadingOlder, update])

  return { ...state, loadingOlder, loadOlder }
}

function LogTab({ context }: { context: UiPluginContext }) {
  const log = useAvatarLog(context)
  const status = useAvatarQuery<StatusResult>(context, 'status')
  const names = nameMap(status.data, null)
  const entries = log.entries
  return (
    <div role="tabpanel" aria-label="Log">
      <Failure message={log.error} />
      {entries.length === 0 ? (
        <EmptyState message="The log is empty." />
      ) : (
        <ul style={LIST_STYLE}>
          {entries.map((entry) => (
            <LogEntryRow key={entry.seq} entry={entry} worktreeName={entry.worktreeId === null ? 'all' : (names.get(entry.worktreeId) ?? entry.worktreeId)} />
          ))}
        </ul>
      )}
      {entries.length > 0 && !log.reachedStart && (
        <Button disabled={log.loadingOlder} onClick={log.loadOlder}>
          {log.loadingOlder ? 'Loading…' : 'Load older entries'}
        </Button>
      )}
    </div>
  )
}

function tabOf(input: unknown): Tab {
  const tab = typeof input === 'object' && input !== null ? (input as { tab?: unknown }).tab : undefined
  return tab === 'report' || tab === 'log' ? tab : 'live'
}

/** The Avatar view with its Live, Report and Log tabs; `input.tab` picks the tab it opens on. */
export default function AvatarView({ context, input }: AvatarUiProps) {
  const requested = tabOf(input)
  const [tab, setTab] = useState<Tab>(requested)
  const status = useAvatarQuery<StatusResult>(context, 'status')
  useEffect(() => setTab(requested), [requested])

  return (
    <ToolPanelFrame title="Avatar">
      <div data-avatar-ui="view">
        <Tabs
          label="Avatar view"
          value={tab}
          onChange={(id) => setTab(id as Tab)}
          items={[
            { id: 'live', label: 'Live' },
            { id: 'report', label: 'Report', count: status.data?.needsYouCount || undefined },
            { id: 'log', label: 'Log' }
          ]}
        />
        {tab === 'live' && <LiveTab context={context} />}
        {tab === 'report' && <ReportTab context={context} onOpenLog={() => setTab('log')} />}
        {tab === 'log' && <LogTab context={context} />}
      </div>
    </ToolPanelFrame>
  )
}
