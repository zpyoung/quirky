import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Badge, Button, FormRow, SectionHeader, StatusDot, TextField } from '@quirky/ui'
import { isRecord, safeHttpUrl, viewWorktree } from './guards'
import type { ReviewsSurfaceProps } from '../contracts'
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation failed.'
}

function viewInputWorktree(props: ReviewsSurfaceProps): string | null {
  return viewWorktree(props.context.getLayout().view?.input)
}

export function CreateReview(props: ReviewsSurfaceProps) {
  const creation = props.state.creation
  const inputWorktree = viewInputWorktree(props)
  const worktree = creation.worktree ?? inputWorktree
  const currentTarget = worktree !== null && creation.worktree === worktree
  const [title, setTitle] = useState(creation.title)
  const [body, setBody] = useState(creation.body)
  const [base, setBase] = useState(creation.base)
  const [draft, setDraft] = useState(creation.draft)
  const [useTemplate, setUseTemplate] = useState(creation.useTemplate)
  const [saving, setSaving] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const submitLock = useRef(false)
  const draftWrites = useRef<Promise<void>>(Promise.resolve())
  const editingDraft = useRef({ title: false, body: false })
  const draftWorktree = useRef(creation.worktree)

  useEffect(() => {
    if (draftWorktree.current !== creation.worktree) {
      draftWorktree.current = creation.worktree
      editingDraft.current = { title: false, body: false }
    }
    if (!editingDraft.current.title) setTitle(creation.title)
    if (!editingDraft.current.body) setBody(creation.body)
    setBase(creation.base)
    setDraft(creation.draft)
    setUseTemplate(creation.useTemplate)
  }, [creation.worktree, creation.title, creation.body, creation.base, creation.draft, creation.useTemplate])

  useEffect(() => {
    if (!inputWorktree || creation.worktree === inputWorktree || creation.loading) return
    setLocalError(null)
    void props.context.call('quirky.reviews/createOpen', { worktree: inputWorktree })
      .then(() => props.refresh())
      .catch((error: unknown) => setLocalError(errorText(error)))
  }, [inputWorktree, creation.worktree, creation.loading, props.context, props.refresh])

  const call = async (method: string, params: Record<string, unknown> = {}) =>
    props.context.call(`quirky.reviews/${method}`, { worktree, ...params })

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const request = draftWrites.current.then(operation)
    draftWrites.current = request.catch(() => undefined)
    return request
  }

  const save = (fields: Record<string, unknown>) => {
    if (!worktree || !currentTarget) return
    setLocalError(null)
    void enqueue(async () => { await call('createDraft', fields) })
      .catch((error: unknown) => setLocalError(errorText(error)))
  }
  const releaseDraftEdit = async (field: 'title' | 'body') => {
    try {
      await draftWrites.current
      editingDraft.current[field] = false
      await props.refresh()
    } catch (error) {
      setLocalError(errorText(error))
    }
  }

  const setBaseValue = async (value: string) => {
    setBase(value)
    if (!worktree || !currentTarget || value === '' || value === creation.base) return
    if (!creation.bases.includes(value)) {
      setLocalError('Choose a remote base branch from the available refs.')
      return
    }
    setLocalError(null)
    try {
      await enqueue(async () => {
        await call('createBase', { base: value })
        await props.refresh()
      })
    } catch (error) {
      setLocalError(errorText(error))
    }
  }

  const eligibility = creation.eligibility
  const blockers = eligibility && Array.isArray(eligibility.blockers) ? eligibility.blockers : []
  const firstBlocker = blockers.find(isRecord)
  const blockerReason = firstBlocker && typeof firstBlocker.reason === 'string' ? firstBlocker.reason : null
  const blockerMessage = firstBlocker && typeof firstBlocker.message === 'string' ? firstBlocker.message : null
  const needsPush = blockerReason === 'branch_ahead' || blockerReason === 'no_upstream'
  const titleMissing = title.trim() === ''
  const baseMissing = base.trim() === ''
  const baseAvailable = creation.bases.includes(base)
  const baseIsHead = base.trim() !== '' && creation.head.trim() !== '' && base.toLowerCase() === creation.head.toLowerCase()
  const stackLookupError = eligibility && typeof eligibility.stackLookupError === 'string' && eligibility.stackLookupError !== ''
    ? eligibility.stackLookupError
    : null
  const confirmedAt = eligibility && typeof eligibility.confirmedAt === 'number' ? eligibility.confirmedAt : Number.NaN
  const eligibilityStale = !Number.isFinite(confirmedAt) || Date.now() - confirmedAt > 5 * 60_000
  const generationRunning = creation.generating
  const canSubmit = currentTarget && !creation.loading && !creation.submitting && !generationRunning && !saving &&
    !titleMissing && !baseMissing && baseAvailable && !baseIsHead && !eligibilityStale && (eligibility?.eligible === true || needsPush)
  const disabledReason = generationRunning ? 'Wait for AI generation to finish.'
    : titleMissing ? 'Enter a pull request title.'
      : baseMissing ? 'Choose a base branch.'
        : !baseAvailable ? 'Choose a base branch from the remote refs.'
          : baseIsHead ? 'Base branch must differ from the head branch.'
            : eligibilityStale ? 'Eligibility confirmation expired. Refresh this worktree before submitting.'
              : blockerMessage && !needsPush ? blockerMessage
                : !eligibility ? 'Confirm eligibility for this worktree before creating a pull request.'
                  : null
  const stackParentNumber = eligibility && Number.isSafeInteger(eligibility.stackParentNumber) ? Number(eligibility.stackParentNumber) : null
  const stackSupported = eligibility?.stackSupported === true
  const stackEnabled = eligibility?.stackEnabled === true && stackParentNumber !== null
  const result = isRecord(creation.result) ? creation.result : null
  const resultReview = result && isRecord(result.review) ? result.review : null
  const resultUrl = resultReview ? safeHttpUrl(resultReview.url) : null
  const resultNumber = resultReview && Number.isSafeInteger(resultReview.number) ? Number(resultReview.number) : null
  const openResult = async () => {
    if (!worktree) return
    setLocalError(null)
    try {
      await props.context.call('quirky.reviews/createOpen', { worktree })
      await props.refresh()
    } catch (error) {
      setLocalError(errorText(error))
    }
  }

  const refreshEligibility = async () => {
    if (!worktree) return
    setLocalError(null)
    try {
      await draftWrites.current
      await props.context.call('quirky.reviews/createOpen', { worktree })
      await props.refresh()
    } catch (error) {
      setLocalError(errorText(error))
    }
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || !worktree || submitLock.current) return
    submitLock.current = true
    setLocalError(null)
    setSaving(true)
    try {
      await draftWrites.current
      if (base !== creation.base) await call('createBase', { base })
      await call('createDraft', { title, body, draft, useTemplate })
      await call('createSubmit')
      await props.refresh()
    } catch (error) {
      setLocalError(errorText(error))
      await props.refresh().catch(() => undefined)
    } finally {
      submitLock.current = false
      setSaving(false)
    }
  }

  const onBodyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      const form = event.currentTarget.form
      if (form) form.requestSubmit()
    }
  }

  const createStack = async (enabled: boolean) => {
    if (!worktree || !currentTarget) return
    setLocalError(null)
    try {
      await enqueue(async () => {
        await call('createBase', { base, stack: enabled })
        await props.refresh()
      })
    } catch (error) {
      setLocalError(errorText(error))
    }
  }
  const generateDetails = async () => {
    if (!worktree || generationRunning) return
    setLocalError(null)
    try {
      await draftWrites.current
      const value = await call('createGenerate')
      if (isRecord(value) && typeof value.title === 'string' && typeof value.body === 'string') {
        setTitle(value.title)
        setBody(value.body)
      }
      await props.refresh()
    } catch (error) {
      setLocalError(errorText(error))
    }
  }

  if (!worktree) {
    return <section className="ui-stack" aria-label="Create pull request">
      <SectionHeader title="Create pull request" />
      <p role="alert"><Badge tone="failing">Select a Git worktree before creating a pull request.</Badge></p>
    </section>
  }

  if (!currentTarget || creation.loading) {
    return <section className="ui-stack" aria-label="Create pull request" aria-busy="true">
      <SectionHeader title="Create pull request" />
      <p role="status" className="ui-text-muted">{localError ?? creation.error ?? 'Confirming this worktree and its current branch…'}</p>
    </section>
  }

  return <main className="ui-stack" aria-label="Create pull request" aria-busy={creation.submitting || generationRunning}>
    <header className="ui-stack">
      <SectionHeader title="Create pull request" />
      <p>Worktree <strong>{worktree}</strong> · <code>{creation.head || 'No current branch'}</code></p>
    </header>

    {creation.error && <p role="alert"><StatusDot status="failing" label="Error" /> {creation.error}</p>}
    {localError && <p role="alert"><StatusDot status="failing" label="Error" /> {localError}</p>}
    {resultReview && <section className="ui-stack" aria-live="polite">
      <strong>{result?.status === 'partial' ? 'Pull request created; stack registration was incomplete.' : result?.status === 'already_exists' ? 'Pull request already exists.' : 'Pull request created.'}</strong>
      <p>{resultNumber === null ? 'The review identity could not be shown.' : `Pull request #${resultNumber}`}{resultUrl ? ` · ${resultUrl}` : ''}</p>
      <Button variant="primary" onClick={() => void openResult()}>Open review</Button>
    </section>}

    <form className="ui-stack" onSubmit={(event) => void submit(event)}>
      <div className="ui-stack">
        <TextField
          id="review-base"
          label="Base branch"
          type="search"
          list="review-base-options"
          value={base}
          aria-label="Search remote base branches"
          help={`Choose a remote branch different from ${creation.head || 'the current branch'}.`}
          disabled={creation.submitting || saving || generationRunning}
          onChange={(event) => setBase(event.target.value)}
          onBlur={() => void setBaseValue(base)}
        />
        <datalist id="review-base-options">
          {creation.bases.map((branch) => <option key={branch} value={branch} />)}
        </datalist>
      </div>
      {creation.bases.length === 0 && <p role="status" className="ui-text-muted">No remote base branches are available.</p>}

      <TextField
        id="review-title"
        label="Title"
        value={title}
        placeholder="Short summary"
        disabled={creation.submitting || saving || generationRunning}
        onChange={(event) => {
          const value = event.target.value
          editingDraft.current.title = true
          setTitle(value)
          save({ title: value })
        }}
        onBlur={() => void releaseDraftEdit('title')}
      />

      <FormRow label="Description" htmlFor="review-body">
        <textarea
          id="review-body"
          className="ui-text-field__input"
          value={body}
          rows={10}
          placeholder="What changed and why?"
          disabled={creation.submitting || saving || generationRunning}
          onChange={(event) => {
            const value = event.target.value
            editingDraft.current.body = true
            setBody(value)
            save({ body: value })
          }}
          onBlur={() => void releaseDraftEdit('body')}
          onKeyDown={onBodyKeyDown}
        />
      </FormRow>
      <small className="ui-text-muted">Use Cmd+Enter (macOS) or Ctrl+Enter to submit.</small>

      <fieldset className="ui-stack" disabled={creation.submitting || saving || generationRunning}>
        <legend>Creation options</legend>
        <FormRow label="Create as draft" htmlFor="review-create-draft">
          <input id="review-create-draft" type="checkbox" style={{ accentColor: 'var(--ui-accent)' }} checked={draft} onChange={(event) => {
            setDraft(event.target.checked)
            void save({ draft: event.target.checked })
          }} />
        </FormRow>
        <FormRow label="Use repository pull-request template when the description is empty" htmlFor="review-use-template">
          <input id="review-use-template" type="checkbox" style={{ accentColor: 'var(--ui-accent)' }} checked={useTemplate} onChange={(event) => {
            setUseTemplate(event.target.checked)
            void save({ useTemplate: event.target.checked })
          }} />
        </FormRow>
        {stackSupported && stackParentNumber !== null && <FormRow label={`Create pull request in stack with #${stackParentNumber}`} htmlFor="review-create-stack">
          <input id="review-create-stack" type="checkbox" style={{ accentColor: 'var(--ui-accent)' }} checked={stackEnabled} onChange={(event) => void createStack(event.target.checked)} />
        </FormRow>}
        {stackSupported && stackParentNumber === null && stackLookupError !== null && <small role="status">Stack capability could not be confirmed: {stackLookupError}</small>}
        {!stackSupported && <small>Stacked pull requests are available only for supported GitHub.com repositories.</small>}
      </fieldset>

      <div className="ui-cluster">
        <Button disabled={creation.submitting || saving || generationRunning} onClick={() => void generateDetails()}>{generationRunning ? 'Generating…' : 'Generate PR details with AI'}</Button>
        {generationRunning && <Button variant="destructive" aria-label="Stop generating pull-request details" onClick={() => {
          if (!worktree) return
          void props.context.call('quirky.reviews/createCancelGenerate', { worktree })
            .then((value: unknown) => {
              if (isRecord(value) && value.cancelled === false) setLocalError('The generation process was no longer running; late output will be discarded.')
              return props.refresh()
            })
            .catch((error: unknown) => setLocalError(errorText(error)))
        }}>Stop</Button>}
        <Button disabled={creation.submitting || saving || generationRunning} onClick={() => void refreshEligibility()}>Refresh eligibility</Button>
        <Button variant="primary" type="submit" disabled={!canSubmit} title={disabledReason ?? undefined}>
          {creation.submitting || saving ? 'Creating…' : stackEnabled ? `${draft ? 'Create draft' : 'Create'} PR in stack` : needsPush ? 'Push & Create PR' : 'Create PR'}
        </Button>
      </div>
      {disabledReason && <p className="ui-text-muted" role="status">{disabledReason}</p>}
      {blockerMessage && needsPush && <p role="status">{blockerMessage}</p>}
    </form>
  </main>
}
