import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Badge, Button, FormRow, SectionHeader, StatusDot, TextField } from '@quirky/ui'
import { isRecord, safeHttpUrl } from './guards'
import type { ReviewsSurfaceProps } from '../contracts'
import { useDraftField, useTargetGuard } from '../draft-field'
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation failed.'
}

function selectedWorktree(props: ReviewsSurfaceProps): string | null {
  const worktree = props.context.getLayout().worktree
  return typeof worktree === 'string' && worktree.trim() !== '' ? worktree : null
}

export function CreateReview(props: ReviewsSurfaceProps) {
  const creation = props.state.creation
  const selectedWorktreeId = selectedWorktree(props)
  const worktree = creation.worktree ?? selectedWorktreeId
  const currentTarget = worktree !== null && creation.worktree === worktree
  const identity = worktree ?? ''
  const targetGuard = useTargetGuard(identity)
  const targetEpoch = useRef({ identity, value: 0 })
  if (targetEpoch.current.identity !== identity) targetEpoch.current = { identity, value: targetEpoch.current.value + 1 }
  const epoch = targetEpoch.current.value
  const latestCreation = useRef(creation)
  latestCreation.current = creation
  const [savingOperation, setSavingOperation] = useState<{ identity: string; isCurrent: () => boolean } | null>(null)
  const [generationEpoch, setGenerationEpoch] = useState<number | null>(null)
  const [errorState, setErrorState] = useState<{ epoch: number; message: string } | null>(null)
  const saving = savingOperation?.identity === identity && savingOperation.isCurrent()
  const generationRunning = creation.generating || generationEpoch === epoch
  const localError = errorState?.epoch === epoch ? errorState.message : null
  const submitLock = useRef<{ identity: string; isCurrent: () => boolean } | null>(null)
  const generationLock = useRef<number | null>(null)
  const draftWrites = useRef<Promise<void>>(Promise.resolve())
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const setLocalError = (message: string | null) => {
    setErrorState(message === null ? null : { epoch, message })
  }
  const enqueue = (operation: () => Promise<unknown>, isCurrent: () => boolean): Promise<void> => {
    const request = draftWrites.current.then(async () => {
      if (!mounted.current || !isCurrent()) return
      await operation()
    })
    draftWrites.current = request.catch(() => undefined)
    return request
  }
  const sendDraft = async (fields: Record<string, unknown>) => {
    if (!worktree || !currentTarget) return false
    const isCurrent = targetGuard()
    await enqueue(
      () => props.context.call('quirky.reviews/createDraft', { worktree, ...fields, generation: creation.generation }),
      isCurrent,
    )
  }
  const sendBase = async (base: string, stack?: boolean) => {
    if (!worktree || !currentTarget) return false
    const isCurrent = targetGuard()
    await enqueue(
      () => props.context.call('quirky.reviews/createBase', {
        worktree,
        base,
        ...(stack === undefined ? {} : { stack }),
        generation: creation.generation,
      }),
      isCurrent,
    )
  }
  const titleField = useDraftField<string>({
    identity,
    remote: creation.title,
    snapshot: props.snapshot,
    write: (value) => sendDraft({ title: value }),
    refresh: props.refresh,
    resend: true,
  })
  const bodyField = useDraftField<string>({
    identity,
    remote: creation.body,
    snapshot: props.snapshot,
    write: (value) => sendDraft({ body: value }),
    refresh: props.refresh,
    resend: true,
  })
  const baseField = useDraftField<string>({
    identity,
    remote: creation.base,
    snapshot: props.snapshot,
    write: (value) => sendBase(value),
    refresh: props.refresh,
    resend: false,
  })
  const draftField = useDraftField<boolean>({
    identity,
    remote: creation.draft,
    snapshot: props.snapshot,
    write: (value) => sendDraft({ draft: value }),
    refresh: props.refresh,
    resend: true,
  })
  const templateField = useDraftField<boolean>({
    identity,
    remote: creation.useTemplate,
    snapshot: props.snapshot,
    write: (value) => sendDraft({ useTemplate: value }),
    refresh: props.refresh,
    resend: true,
  })
  const title = titleField.value
  const body = bodyField.value
  const base = baseField.value
  const draft = draftField.value
  const useTemplate = templateField.value
  const settleDrafts = async (isCurrent: () => boolean) => {
    if (!isCurrent()) return false
    await Promise.all([
      titleField.settled(), bodyField.settled(), baseField.settled(), draftField.settled(), templateField.settled(),
    ])
    if (!isCurrent()) return false
    await draftWrites.current
    if (!isCurrent()) return false
    await Promise.all([
      titleField.settled(), bodyField.settled(), baseField.settled(), draftField.settled(), templateField.settled(),
    ])
    return isCurrent()
  }

  useEffect(() => {
    if (creation.worktree !== null || !selectedWorktreeId || creation.loading) return
    const isCurrent = targetGuard()
    setLocalError(null)
    void props.context.call('quirky.reviews/createOpen', { worktree: selectedWorktreeId })
      .then(async () => {
        if (!isCurrent()) return
        await props.refresh()
      })
      .catch((error: unknown) => {
        if (isCurrent()) setLocalError(errorText(error))
      })
  }, [selectedWorktreeId, creation.worktree, creation.loading, props.context, props.refresh])
  const setBaseValue = (value: string) => {
    if (value === creation.base) {
      baseField.reset(value)
      setLocalError(null)
      return
    }
    if (!worktree || !currentTarget || value === '') return
    if (!creation.bases.includes(value)) {
      setLocalError('Choose a remote base branch from the available refs.')
      return
    }
    setLocalError(null)
    baseField.edit(value)
  }


  const openResult = async () => {
    if (!worktree) return
    const isCurrent = targetGuard()
    setLocalError(null)
    try {
      if (!await settleDrafts(isCurrent)) return
      await props.context.call('quirky.reviews/createOpen', { worktree })
      if (!isCurrent()) return
      await props.refresh()
    } catch (error) {
      if (isCurrent()) setLocalError(errorText(error))
    }
  }

  const refreshEligibility = async () => {
    if (!worktree) return
    const isCurrent = targetGuard()
    setLocalError(null)
    try {
      if (!await settleDrafts(isCurrent)) return
      await props.context.call('quirky.reviews/createOpen', { worktree })
      if (!isCurrent()) return
      await props.refresh()
    } catch (error) {
      if (isCurrent()) setLocalError(errorText(error))
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || !worktree || submitLock.current?.isCurrent()) return
    const isCurrent = targetGuard()
    const operation = { identity, isCurrent }
    submitLock.current = operation
    setLocalError(null)
    setSavingOperation(operation)
    try {
      if (!await settleDrafts(isCurrent)) return
      const titleValue = titleField.value
      const bodyValue = bodyField.value
      const baseValue = baseField.value
      const draftValue = draftField.value
      const templateValue = templateField.value
      if (baseValue !== latestCreation.current.base) {
        await props.context.call('quirky.reviews/createBase', {
          worktree,
          base: baseValue,
          generation: latestCreation.current.generation,
        })
        if (!isCurrent()) return
      }
      await props.context.call('quirky.reviews/createDraft', {
        worktree,
        title: titleValue,
        body: bodyValue,
        draft: draftValue,
        useTemplate: templateValue,
        generation: latestCreation.current.generation,
      })
      if (!isCurrent()) return
      await props.context.call('quirky.reviews/createSubmit', { worktree })
      if (!isCurrent()) return
      await props.refresh()
    } catch (error) {
      if (!isCurrent()) return
      setLocalError(errorText(error))
      await props.refresh().catch(() => undefined)
    } finally {
      if (submitLock.current === operation) submitLock.current = null
      if (isCurrent()) setSavingOperation((current) => current === operation ? null : current)
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
    const isCurrent = targetGuard()
    setLocalError(null)
    try {
      if (!await settleDrafts(isCurrent)) return
      await props.context.call('quirky.reviews/createBase', {
        worktree,
        base: baseField.value,
        stack: enabled,
        generation: latestCreation.current.generation,
      })
      if (!isCurrent()) return
      await props.refresh()
    } catch (error) {
      if (isCurrent()) setLocalError(errorText(error))
    }
  }

  const generateDetails = async () => {
    if (!worktree || !currentTarget || generationRunning || generationLock.current === epoch) return
    const isCurrent = targetGuard()
    const titleAction = titleField.begin()
    const bodyAction = bodyField.begin()
    generationLock.current = epoch
    setGenerationEpoch(epoch)
    setLocalError(null)
    try {
      if (!await settleDrafts(isCurrent)) return
      if (titleAction.status() === 'gone' || bodyAction.status() === 'gone') return
      const priorTitle = titleAction.take()
      const priorBody = bodyAction.take()
      const value = await props.context.call('quirky.reviews/createGenerate', { worktree })
      if (!isCurrent() || titleAction.status() === 'gone' || bodyAction.status() === 'gone') return
      if (isRecord(value) && typeof value.title === 'string' && typeof value.body === 'string') {
        titleAction.succeed(value.title, { send: true })
        bodyAction.succeed(value.body, { send: true })
      } else {
        titleAction.succeed(priorTitle)
        bodyAction.succeed(priorBody)
      }
      if (!await settleDrafts(isCurrent)) return
      await props.refresh()
    } catch (error) {
      if (isCurrent() && titleAction.status() !== 'gone' && bodyAction.status() !== 'gone') {
        titleAction.fail()
        bodyAction.fail()
        setLocalError(errorText(error))
      }
    } finally {
      if (generationLock.current === epoch) generationLock.current = null
      if (isCurrent()) setGenerationEpoch((current) => current === epoch ? null : current)
    }
  }

  const stopGeneration = async () => {
    if (!worktree) return
    const isCurrent = targetGuard()
    try {
      if (!await settleDrafts(isCurrent)) return
      const value = await props.context.call('quirky.reviews/createCancelGenerate', { worktree })
      if (!isCurrent()) return
      if (isRecord(value) && value.cancelled === false) {
        setLocalError('The generation process was no longer running; late output will be discarded.')
      }
      await props.refresh()
    } catch (error) {
      if (isCurrent()) setLocalError(errorText(error))
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
  const fieldError = titleField.error ?? bodyField.error ?? baseField.error ?? draftField.error ?? templateField.error

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
    {fieldError && <p role="alert"><StatusDot status="failing" label="Error" /> {fieldError}</p>}
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
          onChange={(event) => { baseField.hold(event.target.value); setLocalError(null) }}
          onBlur={() => setBaseValue(baseField.value)}
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
          titleField.edit(event.target.value)
          setLocalError(null)
        }}
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
            bodyField.edit(event.target.value)
            setLocalError(null)
          }}
          onKeyDown={onBodyKeyDown}
        />
      </FormRow>
      <small className="ui-text-muted">Use Cmd+Enter (macOS) or Ctrl+Enter to submit.</small>

      <fieldset className="ui-stack" disabled={creation.submitting || saving || generationRunning}>
        <legend>Creation options</legend>
        <FormRow label="Create as draft" htmlFor="review-create-draft">
          <input id="review-create-draft" type="checkbox" style={{ accentColor: 'var(--ui-accent)' }} checked={draft} onChange={(event) => {
            draftField.edit(event.target.checked)
            setLocalError(null)
          }} />
        </FormRow>
        <FormRow label="Use repository pull-request template when the description is empty" htmlFor="review-use-template">
          <input id="review-use-template" type="checkbox" style={{ accentColor: 'var(--ui-accent)' }} checked={useTemplate} onChange={(event) => {
            templateField.edit(event.target.checked)
            setLocalError(null)
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
        {generationRunning && <Button variant="destructive" aria-label="Stop generating pull-request details" onClick={() => void stopGeneration()}>Stop</Button>}
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
