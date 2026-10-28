import { useEffect, useRef, useState } from 'react'
import type { Ask, AskAnswer, AskPartial, AskPartialQuestionDraft, AskQuestion, Repo, Worktree } from '@quirky/protocol'
import type { AttentionToast as AttentionToastState } from './attention'
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  ListRow,
  SectionHeader,
  StatusDot,
  TextField,
  Toast
} from '../design-system'
import { useConnection, usePluginHost, usePluginState } from '../context'
import { PluginSlot } from '../plugins/PluginSlot'
import { attentionStoreFor, useAttention } from './attention'
import './chrome.css'

type ShellTitleBarProps = { onSettings?: () => void }

type ToastAnswer = { label: string; answers: Record<string, AskAnswer>; skipped: string[] }
type QuestionDraft = { selected: string[]; freeText: string; text: string; confirm: boolean | null }
type Drafts = Record<string, QuestionDraft>
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

function worktreeFor(snapshot: { worktrees: Worktree[] | null }, id: string | null): Worktree | undefined {
  return id ? snapshot.worktrees?.find((worktree) => worktree.id === id) : undefined
}

function repoFor(snapshot: { repos: Repo[] | null }, worktree: Worktree | undefined): Repo | undefined {
  return worktree ? snapshot.repos?.find((repo) => repo.id === worktree.repoId) : undefined
}

/** Host-owned project/worktree breadcrumb and canonical command-search trigger. */
export function ShellTitleBar({ onSettings }: ShellTitleBarProps = {}) {
  const { snapshot } = useAttention()
  const { windowRoute } = usePluginState()
  const host = usePluginHost()
  const selected = worktreeFor(snapshot, snapshot.selectedWorktreeId)
  const repo = repoFor(snapshot, selected)
  const showSearch = windowRoute === null
  const projectLabel = repo?.displayName ?? repo?.name ?? (snapshot.selectedWorktreeId ? 'Project unavailable' : 'No project')
  const worktreeLabel = selected?.name ?? snapshot.selectedWorktreeId ?? 'No worktree selected'

  return (
    <header className="shell-titlebar" aria-label="Window title bar">
      <div className="shell-titlebar__breadcrumb" aria-label="Current project and worktree">
        {windowRoute ? (
          <strong>{windowRoute.title ?? 'Auxiliary window'}</strong>
        ) : (
          <>
            <span className="shell-titlebar__project">{projectLabel}</span>
            <span className="shell-titlebar__separator" aria-hidden="true">/</span>
            <strong className="shell-titlebar__worktree">{worktreeLabel}</strong>
            {snapshot.errors.worktrees && <span className="shell-titlebar__error" role="status">Worktree data unavailable</span>}
          </>
        )}
      </div>
      {showSearch && (
        <Button
          className="shell-titlebar__search"
          aria-label="Search commands, tools, views, and worktrees"
          onClick={() => host.setPalette(true)}
        >
          <span>Search</span><kbd>⌘K</kbd>
        </Button>
      )}
      {showSearch && onSettings && <IconButton label="Settings" onClick={onSettings}>⚙</IconButton>}
    </header>
  )
}

/** Canonical branch/activity summary plus the effective status-bar contributions. */
export function ShellStatusBar() {
  const { snapshot } = useAttention()
  const { model, windowRoute } = usePluginState()
  if (windowRoute) return null

  const selected = snapshot.errors.worktrees ? undefined : worktreeFor(snapshot, snapshot.selectedWorktreeId)
  const working = snapshot.errors.sessions ? undefined : snapshot.sessions?.filter((session) => session.status === 'working').length
  const needsYou = snapshot.errors.asks ? undefined : snapshot.asks?.length
  const statusBars = model?.statusBars ?? []

  return (
    <footer className="shell-statusbar" data-region="status-bar" aria-label="Status bar">
      <div className="shell-statusbar__summary" aria-label="Workspace status">
        {selected?.branch && <span className="shell-statusbar__branch">{selected.branch}</span>}
        {working !== undefined && (
          <span className="shell-statusbar__metric">
            <StatusDot status={working > 0 ? 'working' : 'idle'} label={`${working} agents working`} />
            {working} working
          </span>
        )}
        {needsYou !== undefined && (
          <span className="shell-statusbar__metric">
            <Badge tone={needsYou > 0 ? 'needs-you' : 'neutral'} label={`${needsYou} pending questions`}>{needsYou}</Badge>
            <span>needs you</span>
          </span>
        )}
        {snapshot.errors.worktrees && <span className="shell-statusbar__unknown" role="status">Branch unavailable</span>}
        {snapshot.errors.sessions && <span className="shell-statusbar__unknown" role="status">Agent status unavailable</span>}
        {snapshot.errors.asks && <span className="shell-statusbar__unknown" role="status">Inbox status unavailable</span>}
      </div>
      {statusBars.length > 0 && (
        <div className="shell-statusbar__plugins" aria-label="Plugin status">
          {statusBars.map((entry) => <PluginSlot key={entry.id} id={entry.id} />)}
        </div>
      )}
    </footer>
  )
}

function initialDrafts(ask: Ask): Drafts {
  return Object.fromEntries(ask.spec.questions.map((question) => {
    const partial = ask.partial[question.id]
    const selected = partial?.selected ? [...partial.selected] : []
    const freeText = selected.length === 0
      ? partial?.other ?? ''
      : question.type === 'multiselect' ? partial?.other ?? '' : partial?.note ?? ''
    return [question.id, {
      selected,
      freeText,
      text: partial?.draft ?? '',
      confirm: partial?.confirm ?? null
    }]
  }))
}

function partialFor(ask: Ask, drafts: Drafts): AskPartial {
  const partial: AskPartial = {}
  for (const question of ask.spec.questions) {
    const draft = drafts[question.id]!
    const entry: AskPartialQuestionDraft = {}
    if (draft.selected.length > 0) {
      entry.selected = [...draft.selected]
      if (draft.freeText !== '') {
        if (question.type === 'multiselect') entry.other = draft.freeText
        else entry.note = draft.freeText
      }
    } else if (draft.freeText !== '') {
      entry.other = draft.freeText
    }
    if (draft.text !== '') entry.draft = draft.text
    if (draft.confirm !== null) entry.confirm = draft.confirm
    if (Object.keys(entry).length > 0) partial[question.id] = entry
  }
  return partial
}

function answerPayload(ask: Ask, drafts: Drafts): { answers: Record<string, AskAnswer>; skipped: string[] } {
  const answers: Record<string, AskAnswer> = {}
  const skipped: string[] = []
  for (const question of ask.spec.questions) {
    const draft = drafts[question.id]!
    switch (question.type) {
      case 'select': {
        const value = draft.selected[0]
        const option = value === undefined ? undefined : question.options.find((candidate) => candidate.value === value)
        if (value !== undefined) {
          answers[question.id] = {
            value,
            ...(option ? { label: option.label } : {}),
            ...(draft.freeText !== '' ? { note: draft.freeText } : {}),
            source: 'option'
          }
        } else if (draft.freeText !== '') {
          answers[question.id] = { value: draft.freeText, source: 'other' }
        } else if (question.required === false) {
          skipped.push(question.id)
        }
        break
      }
      case 'multiselect':
        if (draft.selected.length > 0 || draft.freeText !== '') {
          answers[question.id] = {
            values: draft.selected,
            labels: draft.selected.map((value) => question.options.find((option) => option.value === value)?.label ?? value),
            ...(draft.freeText !== '' ? { other: draft.freeText } : {}),
            source: 'options'
          }
        } else if (question.required === false) {
          skipped.push(question.id)
        }
        break
      case 'text':
        if (draft.text !== '') answers[question.id] = { value: draft.text, source: 'input' }
        else if (question.required === false) skipped.push(question.id)
        break
      case 'number':
        if (draft.text !== '') answers[question.id] = { value: Number(draft.text), source: 'input' }
        else if (question.required === false) skipped.push(question.id)
        break
      case 'date':
        if (draft.text !== '') answers[question.id] = { value: draft.text, source: 'input' }
        else if (question.required === false) skipped.push(question.id)
        break
      case 'confirm':
        if (draft.confirm !== null) answers[question.id] = { value: draft.confirm, source: 'input' }
        else if (question.required === false) skipped.push(question.id)
        break
    }
  }
  return { answers, skipped }
}

function questionDraft(question: AskQuestion, draft: QuestionDraft, onChange: (draft: QuestionDraft) => void, disabled: boolean) {
  switch (question.type) {
    case 'select':
    case 'multiselect': {
      const multiple = question.type === 'multiselect'
      const toggle = (value: string) => {
        const selected = draft.selected.includes(value)
        const next = multiple
          ? selected ? draft.selected.filter((item) => item !== value) : [...draft.selected, value]
          : selected ? [] : [value]
        onChange({ ...draft, selected: next })
      }
      return (
        <div className="shell-inbox__options" role="group" aria-label={question.question}>
          {question.options.map((option) => (
            <ListRow
              key={option.value}
              title={option.label}
              description={option.description}
              selected={draft.selected.includes(option.value)}
              disabled={disabled}
              onClick={() => toggle(option.value)}
            />
          ))}
          <TextField
            label="Other answer"
            value={draft.freeText}
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, freeText: event.target.value })}
          />
        </div>
      )
    }
    case 'text':
      return question.multiline ? (
        <label className="ui-text-field">
          <span className="ui-text-field__label">{question.question}</span>
          <textarea
            className="ui-text-field__input"
            rows={4}
            value={draft.text}
            disabled={disabled}
            aria-label={question.question}
            onChange={(event) => onChange({ ...draft, text: event.target.value })}
          />
        </label>
      ) : (
        <TextField
          label={question.question}
          value={draft.text}
          disabled={disabled}
          autoComplete="off"
          onChange={(event) => onChange({ ...draft, text: event.target.value })}
        />
      )
    case 'number':
      return (
        <TextField
          label={question.question}
          type="number"
          step={question.integer ? '1' : 'any'}
          min={question.min}
          max={question.max}
          value={draft.text}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, text: event.target.value })}
        />
      )
    case 'date':
      return (
        <TextField
          label={question.question}
          type="date"
          value={draft.text}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, text: event.target.value })}
        />
      )
    case 'confirm':
      return (
        <div className="shell-inbox__confirm" role="group" aria-label={question.question}>
          {([true, false] as const).map((value) => (
            <Button
              key={String(value)}
              variant={draft.confirm === value ? 'primary' : 'secondary'}
              aria-pressed={draft.confirm === value}
              disabled={disabled}
              onClick={() => onChange({ ...draft, confirm: value })}
            >
              {value ? 'Yes' : 'No'}
            </Button>
          ))}
        </div>
      )
  }
}

function primaryAnswer(ask: Ask): ToastAnswer | null {
  if (ask.handoff || ask.queued || ask.spec.questions.length !== 1) return null
  const [question] = ask.spec.questions
  if (!question) return null
  switch (question.type) {
    case 'select': {
      const option = question.options.find((candidate) => candidate.value === question.default) ?? question.options[0]
      if (!option) return null
      return {
        label: option.label,
        answers: { [question.id]: { value: option.value, label: option.label, source: 'option' } },
        skipped: []
      }
    }
    case 'multiselect': {
      if (question.default === undefined) return null
      const options = question.default.map((value) => question.options.find((candidate) => candidate.value === value))
      if (options.some((option) => option === undefined)) return null
      return {
        label: 'Use selected answers',
        answers: { [question.id]: { values: question.default, labels: options.map((option) => option!.label), source: 'options' } },
        skipped: []
      }
    }
    case 'confirm': {
      const value = question.default ?? true
      return { label: value ? 'Yes' : 'No', answers: { [question.id]: { value, source: 'input' } }, skipped: [] }
    }
    case 'text':
    case 'number':
    case 'date':
      return null
  }
}

function InboxAskCard({ ask, worktrees, repos }: { ask: Ask; worktrees: Worktree[] | null; repos: Repo[] | null }) {
  const connection = useConnection()
  const host = usePluginHost()
  const store = attentionStoreFor(connection, host)
  const [drafts, setDrafts] = useState<Drafts>(() => initialDrafts(ask))
  const [saveError, setSaveError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const latest = useRef(drafts)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelSave = () => {
    if (saveTimer.current === null) return false
    clearTimeout(saveTimer.current)
    saveTimer.current = null
    return true
  }
  const scheduleSave = () => {
    cancelSave()
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void connection.callAny('quirky.ask/updatePartial', {
        askId: ask.id,
        partial: partialFor(ask, latest.current)
      }).then(() => setSaveError(null)).catch((error: unknown) => setSaveError(messageOf(error)))
    }, 500)
  }
  useEffect(() => () => { cancelSave() }, [])

  const change = (questionId: string, draft: QuestionDraft) => {
    latest.current = { ...latest.current, [questionId]: draft }
    setDrafts(latest.current)
    scheduleSave()
  }

  const submit = async () => {
    const submission = answerPayload(ask, drafts)
    const hadPendingSave = cancelSave()
    setBusy(true)
    setActionError(null)
    const failure = await store.answer(ask.id, submission.answers, submission.skipped)
    setBusy(false)
    if (failure) {
      setActionError(failure)
      if (hadPendingSave) scheduleSave()
    }
  }

  const openDelegatedQuestion = async () => {
    setBusy(true)
    setActionError(null)
    const opened = await store.openDelegatedQuestion(ask.id)
    setBusy(false)
    if (!opened) setActionError('The delegated question is no longer available in its session.')
  }

  const openedWorktree = ask.worktreeId ? worktrees?.find((worktree) => worktree.id === ask.worktreeId) : undefined
  const project = openedWorktree ? repos?.find((repo) => repo.id === openedWorktree.repoId) : undefined
  const location = [project?.displayName ?? project?.name, openedWorktree?.name ?? ask.worktreeId].filter(Boolean).join(' / ')
  const title = ask.spec.title ?? 'An agent has a question'

  return (
    <article className="shell-inbox__ask" aria-label={title} data-ask-id={ask.id}>
      <header className="shell-inbox__ask-header">
        <div>
          <h3>{title}</h3>
          {location && <p className="shell-inbox__context">{location}</p>}
        </div>
        {ask.queued && <Badge tone="neutral">Queued</Badge>}
      </header>
      {ask.queued ? (
        <>
          <p className="shell-inbox__queued">Waiting behind another question for this session.</p>
          {ask.spec.questions.map((question) => (
            <section className="shell-inbox__question" key={question.id}>
              {question.header && <h4>{question.header}</h4>}
              <p>{question.question}</p>
            </section>
          ))}
        </>
      ) : ask.handoff ? (
        <>
          <p className="shell-inbox__handoff">Answer this question in its delegated session so the response reaches the coordinator.</p>
          {ask.spec.questions.map((question) => (
            <section className="shell-inbox__question" key={question.id}>
              {question.header && <h4>{question.header}</h4>}
              <p>{question.question}</p>
            </section>
          ))}
          {actionError && <p className="ui-error-text" role="alert">{actionError}</p>}
          <Button variant="primary" disabled={busy} onClick={() => void openDelegatedQuestion()}>Open delegated question</Button>
        </>
      ) : (
        <>
          {ask.spec.questions.map((question) => (
            <fieldset className="shell-inbox__question" key={question.id}>
              <legend>{question.header ?? question.question}</legend>
              {question.header && <p>{question.question}</p>}
              {question.required === false && <p className="shell-inbox__optional">Optional</p>}
              {questionDraft(question, drafts[question.id]!, (draft) => change(question.id, draft), busy)}
            </fieldset>
          ))}
          {saveError && <p className="ui-error-text" role="alert">Could not save this draft: {saveError}</p>}
          {actionError && <p className="ui-error-text" role="alert">{actionError}</p>}
          <div className="shell-inbox__actions">
            <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Sending…' : 'Answer'}</Button>
          </div>
        </>
      )}
    </article>
  )
}

/** Host-owned Inbox content; pending asks are read from the daemon and never copied into local authority. */
export function InboxPanel() {
  const { snapshot, store } = useAttention()
  const pending = snapshot.asks
  const error = snapshot.errors.asks
  const sorted = pending ?? []

  return (
    <section className="shell-inbox" aria-label="Inbox questions">
      <SectionHeader
        title="Pending questions"
        actions={pending !== null ? <Badge tone={pending.length > 0 ? 'needs-you' : 'neutral'}>{pending.length}</Badge> : undefined}
      />
      {pending === null && error === undefined && <EmptyState message="Loading pending questions…" />}
      {error && (
        <div className="shell-inbox__error" role="alert">
          <p>Could not load pending questions: {error}</p>
          <Button onClick={store.refresh}>Retry</Button>
        </div>
      )}
      {pending !== null && !error && pending.length === 0 && <EmptyState message="No pending questions." />}
      {pending !== null && !error && sorted.length > 0 && (
        <div className="shell-inbox__list">
          {sorted.map((ask) => <InboxAskCard key={ask.id} ask={ask} worktrees={snapshot.worktrees} repos={snapshot.repos} />)}
        </div>
      )}
    </section>
  )
}

function AttentionToast({ ask, phase, error }: { ask: Ask; phase: AttentionToastState['phase']; error?: string }) {
  const { store } = useAttention()
  const quickAnswer = primaryAnswer(ask)
  const questionText = ask.spec.questions.map((question) => question.question).join('\n') || ask.spec.title
  const action = quickAnswer ? (
    <Button
      variant="primary"
      disabled={phase === 'answering'}
      onClick={() => void store.answer(ask.id, quickAnswer.answers, quickAnswer.skipped)}
    >
      {phase === 'answering' ? 'Sending…' : quickAnswer.label}
    </Button>
  ) : ask.handoff ? (
    <Button variant="primary" disabled={phase === 'answering'} onClick={() => void store.openDelegatedQuestion(ask.id)}>
      Open delegated question
    </Button>
  ) : (
    <Button
      variant="primary"
      onClick={() => {
        store.openInbox()
        store.dismissToast(ask.id)
      }}
    >
      Open Inbox
    </Button>
  )

  return (
    <Toast
      title={ask.spec.title ?? 'An agent has a question'}
      description={(
        <div className="shell-attention-toast__description">
          <p>{questionText}</p>
          {error && <p className="ui-error-text" role="alert">Could not answer: {error}</p>}
          {action}
        </div>
      )}
      status="needs-you"
      durationMs={0}
      onDismiss={() => store.dismissToast(ask.id)}
    />
  )
}

export function AttentionToasts() {
  const { snapshot } = useAttention()
  if (snapshot.toasts.length === 0) return null
  return (
    <div className="shell-attention-toasts" aria-live="polite" aria-label="New questions">
      {snapshot.toasts.map((toast) => (
        <AttentionToast key={toast.ask.id} ask={toast.ask} phase={toast.phase} error={toast.error} />
      ))}
    </div>
  )
}
