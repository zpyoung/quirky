import { Button, Dialog, FormRow, TextField } from '@quirky/ui'
import { useEffect, useRef, useState } from 'react'
import type { IssueDraft, TaskRepo, TasksSurfaceProps } from '../contracts'

type RecordValue = Record<string, unknown>
type SourceChoice = { id: 'origin' | 'upstream'; label: string }
type ChoiceEnvelope = {
  kind: string
  available: boolean
  message: string | null
  labels: string[]
  assignees: { login: string; avatarUrl: string | null }[]
  repositories: TaskRepo[]
  defaultRepoId: string | null
  source: 'origin' | 'upstream'
  sources: SourceChoice[]
  repoId: string | null
}


function record(value: unknown): RecordValue | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as RecordValue
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}


function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultChoices(kind: string): ChoiceEnvelope {
  return { kind, available: false, message: null, labels: [], assignees: [], repositories: [], defaultRepoId: null, source: 'origin', sources: [], repoId: null }
}

export function NewIssueDialog(props: TasksSurfaceProps) {
  const open = props.state.navigation.newIssue
  const [draft, setDraft] = useState<IssueDraft>(props.state.issueDraft)
  const [repositories, setRepositories] = useState<TaskRepo[]>([])
  const [sourceChoices, setSourceChoices] = useState<ChoiceEnvelope>(defaultChoices('source'))
  const [labels, setLabels] = useState<ChoiceEnvelope>(defaultChoices('labels'))
  const [assignees, setAssignees] = useState<ChoiceEnvelope>(defaultChoices('assignees'))
  const [loadingOptions, setLoadingOptions] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [draftError, setDraftError] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newAssignee, setNewAssignee] = useState('')
  const draftRef = useRef(draft)
  const stateDraft = useRef(props.state.issueDraft)
  stateDraft.current = props.state.issueDraft
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const draftFailure = useRef<unknown>(null)
  const submitLock = useRef(false)
  const sourceLoad = useRef(0)
  const optionLoad = useRef(0)

  useEffect(() => {
    if (!open) return
    draftRef.current = stateDraft.current
    setDraft(stateDraft.current)
  }, [open])

  useEffect(() => {
    if (!open) return
    let active = true
    setLoadingOptions(true)
    setError('')
    void props.context.call('quirky.tasks/issueChoices', { kind: 'repositories' }).then((value) => {
      if (!active) return
      const raw = record(value)
      const repos = array(raw?.repositories).flatMap((value) => {
        const repo = record(value)
        if (!repo || typeof repo.id !== 'string' || typeof repo.name !== 'string' || typeof repo.path !== 'string' || typeof repo.worktree !== 'string' || typeof repo.kind !== 'string') return []
        return [{
          id: repo.id,
          name: repo.name,
          path: repo.path,
          kind: repo.kind,
          worktree: repo.worktree,
          ...(typeof repo.displayName === 'string' || repo.displayName === null ? { displayName: repo.displayName } : {})
        }]
      })
      setRepositories(repos)
      const current = draftRef.current
      const chosen = current.repoId && repos.some((repo) => repo.id === current.repoId) ? current.repoId : text(raw?.defaultRepoId)
      if (current.repoId !== chosen) updateDraft({ repoId: chosen })
      if (repos.length === 0) setError('No registered Git repository is selected for issue creation.')
    }).catch((reason: unknown) => {
      if (active) setError(errorText(reason))
    }).finally(() => {
      if (active) setLoadingOptions(false)
    })
    return () => { active = false }
  }, [open, props.context])

  useEffect(() => {
    if (!open || !draft.repoId) {
      setSourceChoices(defaultChoices('source'))
      setLabels(defaultChoices('labels'))
      setAssignees(defaultChoices('assignees'))
      return
    }
    let active = true
    const request = ++sourceLoad.current
    setError((current) => current.startsWith('Issue source') ? '' : current)
    void props.context.call('quirky.tasks/issueChoices', { kind: 'source', repoId: draft.repoId }).then((value) => {
      if (!active || request !== sourceLoad.current) return
      const raw = record(value)
      const sources = array(raw?.sources).flatMap<SourceChoice>((value) => {
        const source = record(value)
        if (!source) return []
        const id = source.id
        if ((id !== 'origin' && id !== 'upstream') || typeof source.label !== 'string') return []
        return [{ id, label: source.label }]
      })
      setSourceChoices({
        ...defaultChoices('source'),
        available: raw?.available === true,
        source: raw?.source === 'upstream' ? 'upstream' : 'origin',
        sources,
        repoId: typeof raw?.repoId === 'string' ? raw.repoId : draft.repoId,
        message: text(raw?.message)
      })
    }).catch((reason: unknown) => {
      if (active && request === sourceLoad.current) setError(`Issue source could not be loaded: ${errorText(reason)}`)
    })

    const optionRequest = ++optionLoad.current
    void Promise.all([
      props.context.call('quirky.tasks/issueChoices', { kind: 'labels', repoId: draft.repoId }),
      props.context.call('quirky.tasks/issueChoices', { kind: 'assignees', repoId: draft.repoId })
    ]).then((values) => {
      if (!active || optionRequest !== optionLoad.current) return
      const labelResult = record(values[0])
      const assigneeResult = record(values[1])
      setLabels({
        ...defaultChoices('labels'),
        available: labelResult?.available === true,
        labels: array(labelResult?.labels).flatMap((label) => typeof label === 'string' ? [label] : []).slice(0, 100),
        repoId: draft.repoId,
        message: text(labelResult?.message)
      })
      setAssignees({
        ...defaultChoices('assignees'),
        available: assigneeResult?.available === true,
        assignees: array(assigneeResult?.assignees).flatMap((value) => {
          const user = record(value)
          return typeof user?.login === 'string' ? [{ login: user.login, avatarUrl: text(user.avatarUrl) }] : []
        }).slice(0, 100),
        repoId: draft.repoId,
        message: text(assigneeResult?.message)
      })
    }).catch((reason: unknown) => {
      if (active && optionRequest === optionLoad.current) setError(`Issue choices could not be loaded: ${errorText(reason)}`)
    })
    return () => { active = false }
  }, [open, props.context, draft.repoId])

  const selectedRepo = repositories.find((repo) => repo.id === draft.repoId) ?? null
  const choicesAvailable = labels.available && assignees.available
  const selectedSourceLabel = sourceChoices.sources.find((source) => source.id === sourceChoices.source)?.label

  function updateDraft(patch: Partial<IssueDraft>) {
    const previous = draftRef.current
    const repoChanged = patch.repoId !== undefined && patch.repoId !== previous.repoId
    const next: IssueDraft = {
      ...previous,
      ...patch,
      labels: repoChanged && patch.labels === undefined ? [] : patch.labels ?? previous.labels,
      assignees: repoChanged && patch.assignees === undefined ? [] : patch.assignees ?? previous.assignees
    }
    if (repoChanged) {
      setNewLabel('')
      setNewAssignee('')
    }
    draftRef.current = next
    setDraft(next)
    setDraftError('')
    saveQueue.current = saveQueue.current.catch(() => undefined)
      .then(() => props.context.call('quirky.tasks/draft', patch as Record<string, unknown>))
      .then(() => {
        draftFailure.current = null
        setDraftError('')
      })
      .catch((reason: unknown) => {
        draftFailure.current = reason
        setDraftError(errorText(reason))
      })
  }

  async function changeIssueSource(source: 'origin' | 'upstream') {
    const repoId = draft.repoId
    if (!repoId || source === sourceChoices.source) return
    const request = ++sourceLoad.current
    const optionRequest = ++optionLoad.current
    let sourceSaved = false
    setError('')
    try {
      await saveQueue.current
      if (draftFailure.current) throw new Error(`The issue draft was not saved: ${errorText(draftFailure.current)}`)
      await props.context.call('quirky.tasks/issueSource', { repoId, source })
      sourceSaved = true
      if (request !== sourceLoad.current || optionRequest !== optionLoad.current || draftRef.current.repoId !== repoId) return
      setSourceChoices((current) => ({ ...current, source }))
      setNewLabel('')
      setNewAssignee('')
      updateDraft({ labels: [], assignees: [] })
      await saveQueue.current
      if (draftFailure.current) throw new Error(`The source changed, but repository-scoped draft selections could not be cleared: ${errorText(draftFailure.current)}`)
      if (request !== sourceLoad.current || optionRequest !== optionLoad.current || draftRef.current.repoId !== repoId) return
      const values = await Promise.all([
        props.context.call('quirky.tasks/issueChoices', { kind: 'labels', repoId }),
        props.context.call('quirky.tasks/issueChoices', { kind: 'assignees', repoId })
      ])
      if (request !== sourceLoad.current || optionRequest !== optionLoad.current || draftRef.current.repoId !== repoId) return
      const labelResult = record(values[0])
      const assigneeResult = record(values[1])
      setLabels((current) => ({
        ...current,
        available: labelResult?.available === true,
        labels: array(labelResult?.labels).flatMap((label) => typeof label === 'string' ? [label] : []).slice(0, 100),
        message: text(labelResult?.message)
      }))
      setAssignees((current) => ({
        ...current,
        available: assigneeResult?.available === true,
        assignees: array(assigneeResult?.assignees).flatMap((value) => {
          const user = record(value)
          return typeof user?.login === 'string' ? [{ login: user.login, avatarUrl: text(user.avatarUrl) }] : []
        }).slice(0, 100),
        message: text(assigneeResult?.message)
      }))
    } catch (reason: unknown) {
      if (request === sourceLoad.current && optionRequest === optionLoad.current && draftRef.current.repoId === repoId) {
        setError(sourceSaved
          ? `Issue source changed, but its repository choices could not be refreshed: ${errorText(reason)}`
          : `Issue source could not be changed: ${errorText(reason)}`)
      }
    }
  }

  async function closeDialog() {
    try {
      await saveQueue.current
      if (draftFailure.current) throw new Error(`The issue draft was not saved: ${errorText(draftFailure.current)}`)
      await props.context.call('quirky.tasks/navigate', { newIssue: false })
    } catch (reason: unknown) {
      setError(errorText(reason))
    }
  }

  async function createIssue() {
    if (submitLock.current || submitting || draft.title.trim().length === 0 || !selectedRepo) return
    submitLock.current = true
    setSubmitting(true)
    setError('')
    try {
      await saveQueue.current
      if (draftFailure.current) throw new Error(`The issue draft was not saved: ${errorText(draftFailure.current)}`)
      const result = record(await props.context.call('quirky.tasks/createIssue', {}))
      const item = record(result?.item)
      if (!item || typeof item.number !== 'number') throw new Error('GitHub did not return the created issue.')
      if (typeof result?.bodySaveWarning === 'string') props.context.toast('Issue created with a description warning', result.bodySaveWarning)
      else props.context.toast('Issue created', `Opened issue #${item.number}.`)
      try {
        await props.refresh()
      } catch (reason: unknown) {
        props.context.toast('Issue created', `The issue was created, but the list could not refresh: ${errorText(reason)}`)
      }
    } catch (reason: unknown) {
      setError(errorText(reason))
    } finally {
      submitLock.current = false
      setSubmitting(false)
    }
  }

  if (!open) return null
  const labelSet = new Set(draft.labels)
  const assigneeSet = new Set(draft.assignees)
  const titleMissing = draft.title.trim().length === 0

  const actions = <div className="quirky-tasks-new-issue__actions">
    <span className="ui-text-muted">Cmd+Enter to submit</span>
    <Button type="button" onClick={() => void closeDialog()} disabled={submitting}>Cancel</Button>
    <Button type="button" variant="primary" onClick={() => void createIssue()} disabled={submitting || titleMissing || !selectedRepo}>{submitting ? 'Creating…' : 'Create issue'}</Button>
  </div>

  return <Dialog open={open} title="New GitHub issue" onClose={() => { void closeDialog() }} closeOnBackdrop={false} actions={actions}>
    <div className="quirky-tasks-new-issue" onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault()
        void createIssue()
      }
    }}>
      <p className="quirky-tasks-new-issue__destination">Filing in {selectedSourceLabel ?? selectedRepo?.displayName ?? selectedRepo?.name ?? 'a selected repository'}</p>

      {loadingOptions && <p className="quirky-tasks-new-issue__status" role="status">Loading selected repositories…</p>}
      {repositories.length > 1 && <FormRow label="Project" htmlFor="new-issue-repo">
        <select id="new-issue-repo" aria-label="Issue repository" value={draft.repoId ?? ''} onChange={(event) => updateDraft({ repoId: event.currentTarget.value || null })} disabled={submitting} className="quirky-tasks-control">
          {repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.displayName ?? repo.name}</option>)}
        </select>
      </FormRow>}

      {sourceChoices.sources.length > 1 && <FormRow label="Issue source" htmlFor="new-issue-source">
        <select id="new-issue-source" aria-label="Issue source" value={sourceChoices.source} onChange={(event) => {
          const selected = event.currentTarget.value
          if (selected === 'origin' || selected === 'upstream') void changeIssueSource(selected)
        }} disabled={submitting} className="quirky-tasks-control">
          {sourceChoices.sources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
        </select>
      </FormRow>}
      {sourceChoices.message && <p className="quirky-tasks-new-issue__status">{sourceChoices.message}</p>}

      <TextField
        label="Title"
        id="new-issue-title"
        autoFocus
        value={draft.title}
        placeholder="Short summary"
        onChange={(event) => updateDraft({ title: event.currentTarget.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void createIssue()
          }
        }}
        disabled={submitting || !selectedRepo}
      />

      <section className="quirky-tasks-new-issue__description" aria-label="Issue description">
        <p>Description (optional, Markdown)</p>
        <MarkdownComposer value={draft.body} onChange={(body) => updateDraft({ body })} label="Issue description" placeholder="What's going on?" disabled={submitting || !selectedRepo} minRows={8} onSubmit={() => void createIssue()} />
      </section>

      <div className="quirky-tasks-new-issue__collections">
        <fieldset className="quirky-tasks-new-issue__fieldset">
          <legend>Labels</legend>
          {!choicesAvailable && <p className="quirky-tasks-new-issue__status">{labels.message ?? 'Loading repository labels…'}</p>}
          <div className="quirky-tasks-new-issue__choices">
            {labels.labels.map((label) => <label key={label} className="quirky-tasks-new-issue__choice">
              <input type="checkbox" checked={labelSet.has(label)} disabled={submitting} onChange={(event) => updateDraft({ labels: event.currentTarget.checked ? [...new Set([...draft.labels, label])] : draft.labels.filter((value) => value !== label) })} />
              {label}
            </label>)}
          </div>
          <TextField label="Add label" value={newLabel} onChange={(event) => setNewLabel(event.currentTarget.value)} disabled={submitting || !selectedRepo} />
          <Button type="button" className="quirky-tasks-new-issue__add" onClick={() => {
            const label = newLabel.trim()
            if (label) updateDraft({ labels: [...new Set([...draft.labels, label])] })
            setNewLabel('')
          }} disabled={submitting || !selectedRepo || newLabel.trim().length === 0}>Add label</Button>
        </fieldset>

        <fieldset className="quirky-tasks-new-issue__fieldset">
          <legend>Assignees</legend>
          {!choicesAvailable && <p className="quirky-tasks-new-issue__status">{assignees.message ?? 'Loading assignable users…'}</p>}
          <div className="quirky-tasks-new-issue__choices">
            {assignees.assignees.map((user) => <label key={user.login} className="quirky-tasks-new-issue__choice">
              <input type="checkbox" checked={assigneeSet.has(user.login)} disabled={submitting} onChange={(event) => updateDraft({ assignees: event.currentTarget.checked ? [...new Set([...draft.assignees, user.login])] : draft.assignees.filter((value) => value !== user.login) })} />
              {user.login}
            </label>)}
          </div>
          <TextField label="Add assignee login" value={newAssignee} onChange={(event) => setNewAssignee(event.currentTarget.value)} disabled={submitting || !selectedRepo} />
          <Button type="button" className="quirky-tasks-new-issue__add" onClick={() => {
            const assignee = newAssignee.trim()
            if (assignee) updateDraft({ assignees: [...new Set([...draft.assignees, assignee])] })
            setNewAssignee('')
          }} disabled={submitting || !selectedRepo || newAssignee.trim().length === 0}>Add assignee</Button>
        </fieldset>
      </div>

      {draftError && <p className="quirky-tasks-new-issue__error" role="alert">Draft could not be saved: {draftError}</p>}
      {error && <p className="quirky-tasks-new-issue__error" role="alert">{error}</p>}
    </div>
  </Dialog>
}
