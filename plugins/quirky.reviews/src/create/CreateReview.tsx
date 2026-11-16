import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Button, EmptyState, FormRow, InlineError, NoticeLine, SectionHeader, TextField } from '@quirky/ui'
import { isRecord, safeHttpUrl } from './guards'
import { CREATE_VIEW, type ReviewsSurfaceProps } from '../contracts'
import {
  registerReviewsUiControl,
  requestReviewsUiControl,
  type ReviewsUiControlRegistration,
  type ReviewsUiControlRequest,
  type ReviewsUiControlResult
} from '../checks/data'
import { useDraftField, useTargetGuard } from '../draft-field'
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation failed.'
}

function selectedWorktree(props: ReviewsSurfaceProps): string | null {
  const worktree = props.context.getLayout().worktree
  return typeof worktree === 'string' && worktree.trim() !== '' ? worktree : null
}

type CreationControlAction =
  | 'submit'
  | 'refresh-eligibility'
  | 'open-result'
  | 'generate'
  | 'stop-generation'
  | 'base-set'
  | 'stack-set'

type CreationOperation = { identity: string; isCurrent: () => boolean }
type CreationGenerationActions = { identity: string; token: object; retire(): void }

type CreationControlSnapshot = {
  worktree: string | null
  currentTarget: boolean
  creation: ReviewsSurfaceProps['state']['creation']
  title: string
  base: string
  generationRunning: boolean
  saving: boolean
  stackSaving: boolean
  resultReview: Record<string, unknown> | null
  stackSupported: boolean
  stackParentNumber: number | null
}

type CreationControlBusy = {
  submit: boolean
  refresh: boolean
  openResult: boolean
  generate: boolean
  stop: boolean
  stack: boolean
}

type CreationControlLease = {
  target: string
  session: string
  lease: { generation: number; changed(): void; dispose(): void }
}

function creationControlActions(
  state: CreationControlSnapshot,
  busy: CreationControlBusy
): Array<{ action: CreationControlAction; enabled: boolean }> {
  const { creation } = state
  const eligibility = creation.eligibility
  const blockers = eligibility && Array.isArray(eligibility.blockers) ? eligibility.blockers : []
  const firstBlocker = blockers.find(isRecord)
  const blockerReason = firstBlocker && typeof firstBlocker.reason === 'string' ? firstBlocker.reason : null
  const needsPush = blockerReason === 'branch_ahead' || blockerReason === 'no_upstream'
  const confirmedAt = eligibility && typeof eligibility.confirmedAt === 'number' ? eligibility.confirmedAt : Number.NaN
  const eligibilityStale = !Number.isFinite(confirmedAt) || Date.now() - confirmedAt > 5 * 60_000
  const baseAvailable = creation.bases.includes(state.base)
  const baseIsHead = state.base.trim() !== '' && creation.head.trim() !== '' &&
    state.base.toLowerCase() === creation.head.toLowerCase()
  const busyEditing = creation.loading || creation.submitting || state.saving || state.stackSaving ||
    state.generationRunning || busy.submit || busy.stack
  const resultAvailable = state.resultReview !== null

  return [
    {
      action: 'submit',
      enabled: state.currentTarget && !busyEditing &&
        state.title.trim() !== '' && state.base.trim() !== '' && baseAvailable && !baseIsHead &&
        !eligibilityStale && (eligibility?.eligible === true || needsPush)
    },
    {
      action: 'refresh-eligibility',
      enabled: state.worktree !== null && !creation.loading && !creation.submitting && !state.saving &&
        !state.stackSaving && !state.generationRunning && !busy.refresh && !busy.submit && !busy.stack && !busy.openResult
    },
    ...(resultAvailable ? [{
      action: 'open-result' as const,
      enabled: state.currentTarget && !busyEditing && !busy.openResult && !busy.refresh
    }] : []),
    {
      action: 'generate',
      enabled: state.currentTarget && !busyEditing && !busy.generate
    },
    {
      action: 'stop-generation',
      enabled: state.worktree !== null && state.currentTarget && state.generationRunning && !busy.stop
    },
    {
      action: 'base-set',
      enabled: state.worktree !== null && state.currentTarget && !busyEditing
    },
    {
      action: 'stack-set',
      enabled: state.worktree !== null && state.currentTarget && !busyEditing &&
        state.stackSupported && state.stackParentNumber !== null && !busy.stack
    }
  ]
}

function requireNoCreationControlValue(request: ReviewsUiControlRequest): void {
  if (Object.hasOwn(request, 'value')) throw new Error('This creation action does not accept a value.')
}

function requireCreationControlValue(request: ReviewsUiControlRequest, key: string): Record<string, unknown> {
  const value = request.value
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, key)) {
    throw new Error('Invalid creation action value.')
  }
  return value
}

export function CreateReview(props: ReviewsSurfaceProps) {
  const creation = props.state.creation
  const selectedWorktreeId = selectedWorktree(props)
  const worktree = creation.worktree ?? selectedWorktreeId
  const controlWorktree = worktree !== null && worktree.trim() !== '' ? worktree : null
  const currentTarget = controlWorktree !== null && creation.worktree === controlWorktree
  const identity = controlWorktree ?? ''
  const eligibility = creation.eligibility
  const headIdentity = eligibility && typeof eligibility.headOid === 'string' && eligibility.headOid.trim() !== ''
    ? eligibility.headOid
    : creation.head || null
  const sessionIdentity = JSON.stringify([controlWorktree, creation.generation, headIdentity, creation.head])
  const controlTarget = JSON.stringify([CREATE_VIEW, 'creation', controlWorktree, null, null, controlWorktree ? headIdentity : null, null])
  const targetGuard = useTargetGuard(sessionIdentity)
  const targetEpoch = useRef({ identity: sessionIdentity, value: 0 })
  if (targetEpoch.current.identity !== sessionIdentity) {
    targetEpoch.current = { identity: sessionIdentity, value: targetEpoch.current.value + 1 }
  }
  const epoch = targetEpoch.current.value
  const latestCreation = useRef(creation)
  latestCreation.current = creation
  const [savingOperation, setSavingOperation] = useState<CreationOperation | null>(null)
  const [stackOperation, setStackOperation] = useState<CreationOperation | null>(null)
  const [generationEpoch, setGenerationEpoch] = useState<number | null>(null)
  const [errorState, setErrorState] = useState<{ epoch: number; message: string } | null>(null)
  const saving = savingOperation?.identity === sessionIdentity && savingOperation.isCurrent()
  const stackSaving = stackOperation?.identity === sessionIdentity && stackOperation.isCurrent()
  const generationRunning = creation.generating || generationEpoch === epoch
  const localError = errorState?.epoch === epoch ? errorState.message : null
  const [confirmationOperation, setConfirmationOperation] = useState<CreationOperation | null>(null)
  const confirmationPending = confirmationOperation?.identity === sessionIdentity && confirmationOperation.isCurrent()
  const [controlLeaseState, setControlLeaseState] = useState<{ target: string; generation: number } | null>(null)
  const controlRegistration = useRef<CreationControlLease | null>(null)
  const controlSession = useRef(sessionIdentity)
  controlSession.current = sessionIdentity
  const actionSignature = useRef<string | null>(null)
  const publishActionSignature = useRef<() => void>(() => {})
  const confirmationLock = useRef<CreationOperation | null>(null)
  const confirmationAttempted = useRef<string | null>(null)
  const eligibilityLock = useRef<CreationOperation | null>(null)
  const submitLock = useRef<CreationOperation | null>(null)
  const openResultLock = useRef<CreationOperation | null>(null)
  const stackLock = useRef<CreationOperation | null>(null)
  const stopLock = useRef<CreationOperation | null>(null)
  const generationLock = useRef<number | null>(null)
  const generationActions = useRef<CreationGenerationActions | null>(null)
  const suppressGenerationRetirementRefresh = useRef(false)
  const draftWrites = useRef<Promise<void>>(Promise.resolve())
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const setLocalError = (message: string | null) => {
    setErrorState(message === null ? null : { epoch, message })
  }
  const enqueue = (operation: () => Promise<unknown>, isCurrent: () => boolean): Promise<boolean> => {
    const request = draftWrites.current.then(async () => {
      if (!mounted.current || !isCurrent()) return false
      try {
        await operation()
      } catch (error) {
        if (!mounted.current || !isCurrent()) return false
        throw error
      }
      return mounted.current && isCurrent()
    })
    draftWrites.current = request.then(() => undefined, () => undefined)
    return request
  }
  const sendDraft = async (fields: Record<string, unknown>) => {
    if (!worktree || !currentTarget) return false
    const isCurrent = targetGuard()
    return enqueue(
      () => props.context.call('quirky.reviews/createDraft', { worktree, ...fields, generation: creation.generation }),
      isCurrent,
    )
  }
  const sendBase = async (base: string, stack?: boolean) => {
    if (!worktree || !currentTarget) return false
    const isCurrent = targetGuard()
    return enqueue(
      () => props.context.call('quirky.reviews/createBase', {
        worktree,
        base,
        ...(stack === undefined ? {} : { stack }),
        generation: creation.generation,
      }),
      isCurrent,
    )
  }
  const refreshDraftFields = () => {
    if (suppressGenerationRetirementRefresh.current) return Promise.resolve()
    return props.refresh()
  }
  useLayoutEffect(() => {
    const actionIdentity = sessionIdentity
    return () => {
      const actions = generationActions.current
      if (actions?.identity === actionIdentity) actions.retire()
    }
  }, [sessionIdentity])
  const titleField = useDraftField<string>({
    identity,
    remote: creation.title,
    snapshot: props.snapshot,
    write(value) { return sendDraft({ title: value }) },
    refresh: refreshDraftFields,
    resend: true,
  })
  const bodyField = useDraftField<string>({
    identity,
    remote: creation.body,
    snapshot: props.snapshot,
    write(value) { return sendDraft({ body: value }) },
    refresh: refreshDraftFields,
    resend: true,
  })
  const baseField = useDraftField<string>({
    identity,
    remote: creation.base,
    snapshot: props.snapshot,
    write(value) { return sendBase(value) },
    refresh: props.refresh,
    resend: false,
  })
  const draftField = useDraftField<boolean>({
    identity,
    remote: creation.draft,
    snapshot: props.snapshot,
    write(value) { return sendDraft({ draft: value }) },
    refresh: props.refresh,
    resend: true,
  })
  const templateField = useDraftField<boolean>({
    identity,
    remote: creation.useTemplate,
    snapshot: props.snapshot,
    write(value) { return sendDraft({ useTemplate: value }) },
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
    const confirmationKey = JSON.stringify([selectedWorktreeId, epoch])
    if (confirmationAttempted.current === confirmationKey || confirmationLock.current?.isCurrent()) return
    confirmationAttempted.current = confirmationKey
    const isCurrent = targetGuard()
    const operation = { identity: sessionIdentity, isCurrent }
    confirmationLock.current = operation
    publishActionSignature.current()
    setConfirmationOperation(operation)
    setLocalError(null)
    void props.context.call('quirky.reviews/createOpen', { worktree: selectedWorktreeId })
      .then(async () => {
        if (!isCurrent()) return
        await props.refresh()
      })
      .catch((error: unknown) => {
        if (isCurrent()) setLocalError(errorText(error))
      })
      .finally(() => {
        if (confirmationLock.current === operation) {
          confirmationLock.current = null
          publishActionSignature.current()
        }
        if (mounted.current) setConfirmationOperation((current) => current === operation ? null : current)
      })
  }, [selectedWorktreeId, creation.worktree, creation.loading, sessionIdentity, props.context, props.refresh])
  const setBaseValue = (value: string, isCurrent: () => boolean) => {
    if (!isCurrent() || !worktree || !currentTarget) return
    if (value !== '' && !creation.bases.includes(value)) {
      setLocalError('Choose a remote base branch from the available refs.')
      return
    }
    if (value === creation.base) {
      baseField.reset(value)
      setLocalError(null)
      return
    }
    if (value === '') return
    setLocalError(null)
    baseField.edit(value)
  }

  const openResult = async (isCurrent: () => boolean) => {
    if (!worktree || !currentTarget || openResultLock.current?.isCurrent()) return
    const operation = { identity: sessionIdentity, isCurrent }
    openResultLock.current = operation
    publishActionSignature.current()
    setLocalError(null)
    try {
      if (!await settleDrafts(isCurrent)) return
      await props.context.call('quirky.reviews/createOpen', { worktree })
      if (!isCurrent()) return
      await props.refresh()
    } catch (error) {
      if (isCurrent()) setLocalError(errorText(error))
    } finally {
      if (openResultLock.current === operation) {
        openResultLock.current = null
        publishActionSignature.current()
      }
    }
  }

  const refreshEligibility = async (isCurrent: () => boolean) => {
    if (!worktree || !isCurrent()) return
    const isConfirmation = !currentTarget
    const lock = isConfirmation ? confirmationLock : eligibilityLock
    if (lock.current?.isCurrent()) return
    const operation = { identity: sessionIdentity, isCurrent }
    lock.current = operation
    publishActionSignature.current()
    if (isConfirmation) setConfirmationOperation(operation)
    setLocalError(null)
    try {
      if (!isConfirmation && !await settleDrafts(isCurrent)) return
      await props.context.call('quirky.reviews/createOpen', { worktree })
      if (!isCurrent()) return
      await props.refresh()
    } catch (error) {
      if (isCurrent()) setLocalError(errorText(error))
    } finally {
      if (lock.current === operation) {
        lock.current = null
        publishActionSignature.current()
      }
      if (isConfirmation && mounted.current) {
        setConfirmationOperation((current) => current === operation ? null : current)
      }
    }
  }

  const submit = async (isCurrent: () => boolean) => {
    if (!worktree || !isCurrent() || submitLock.current?.isCurrent()) return
    const operation = { identity: sessionIdentity, isCurrent }
    submitLock.current = operation
    publishActionSignature.current()
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
      if (submitLock.current === operation) {
        submitLock.current = null
        publishActionSignature.current()
      }
      if (isCurrent()) setSavingOperation((current) => current === operation ? null : current)
    }
  }

  const onBodyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      requestCreationControl('submit')
    }
  }

  const createStack = async (enabled: boolean, isCurrent: () => boolean) => {
    if (!worktree || !currentTarget || stackLock.current?.isCurrent()) return
    const operation = { identity: sessionIdentity, isCurrent }
    stackLock.current = operation
    setStackOperation(operation)
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
    } finally {
      if (stackLock.current === operation) {
        stackLock.current = null
        publishActionSignature.current()
      }
      if (mounted.current) setStackOperation((current) => current === operation ? null : current)
    }
  }

  const generateDetails = async (isCurrent: () => boolean) => {
    if (!worktree || !currentTarget || generationRunning || generationLock.current === epoch) return
    const capturedRemoteTitle = creation.title
    const capturedRemoteBody = creation.body
    let draftsSettled = false
    const titleAction = titleField.begin()
    const bodyAction = bodyField.begin()
    const generationToken = {}
    const generationOwner: CreationGenerationActions = {
      identity: sessionIdentity,
      token: generationToken,
      retire: () => {
        if (generationActions.current?.token !== generationToken) return
        const keepTitle = !draftsSettled || titleAction.status() !== 'same' ||
          titleField.error !== null || titleField.value !== capturedRemoteTitle
        const keepBody = !draftsSettled || bodyAction.status() !== 'same' ||
          bodyField.error !== null || bodyField.value !== capturedRemoteBody
        suppressGenerationRetirementRefresh.current = true
        try {
          if (keepTitle) titleAction.fail()
          else titleAction.succeed(latestCreation.current.title)
          if (keepBody) bodyAction.fail()
          else bodyAction.succeed(latestCreation.current.body)
        } finally {
          suppressGenerationRetirementRefresh.current = false
          if (generationActions.current?.token === generationToken) generationActions.current = null
        }
      }
    }
    generationActions.current = generationOwner
    generationLock.current = epoch
    publishActionSignature.current()
    setGenerationEpoch(epoch)
    setLocalError(null)
    try {
      if (!await settleDrafts(isCurrent)) return
      draftsSettled = true
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
      if (generationActions.current?.token === generationToken) {
        if (!isCurrent()) generationOwner.retire()
        else generationActions.current = null
      }
      if (generationLock.current === epoch) {
        generationLock.current = null
        publishActionSignature.current()
      }
      if (isCurrent()) setGenerationEpoch((current) => current === epoch ? null : current)
    }
  }

  const stopGeneration = async (isCurrent: () => boolean) => {
    if (!worktree || !currentTarget || !generationRunning || stopLock.current?.isCurrent()) return
    const operation = { identity: sessionIdentity, isCurrent }
    stopLock.current = operation
    publishActionSignature.current()
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
    } finally {
      if (stopLock.current === operation) {
        stopLock.current = null
        publishActionSignature.current()
      }
    }
  }

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
    !submitLock.current?.isCurrent() && !titleMissing && !baseMissing && baseAvailable && !baseIsHead &&
    !eligibilityStale && (eligibility?.eligible === true || needsPush)
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
  const partialError = result?.status === 'partial' ? 'Pull request created; stack registration was incomplete.' : null
  const stateErrors = [creation.error, localError, fieldError, partialError && creation.error !== partialError ? partialError : null]
    .filter((message): message is string => typeof message === 'string' && message !== '')

  const controlSnapshot: CreationControlSnapshot = {
    worktree: controlWorktree,
    currentTarget,
    creation,
    title,
    base,
    generationRunning,
    saving,
    stackSaving,
    resultReview,
    stackSupported,
    stackParentNumber
  }
  const controlSnapshotRef = useRef(controlSnapshot)
  controlSnapshotRef.current = controlSnapshot
  const controlRunner = useRef<(request: ReviewsUiControlRequest, isCurrent: () => boolean) => void>(() => {})
  const getControlActions = () => {
    const snapshot = controlSnapshotRef.current
    snapshot.title = titleField.value
    snapshot.base = baseField.value
    snapshot.generationRunning = snapshot.creation.generating || generationLock.current === epoch
    return creationControlActions(snapshot, {
      submit: Boolean(submitLock.current?.isCurrent()),
      refresh: Boolean(confirmationLock.current?.isCurrent() || eligibilityLock.current?.isCurrent()),
      openResult: Boolean(openResultLock.current?.isCurrent()),
      generate: generationLock.current === epoch,
      stop: Boolean(stopLock.current?.isCurrent()),
      stack: Boolean(stackLock.current?.isCurrent())
    })
  }
  const getActionSignature = () => JSON.stringify(getControlActions().map(({ action, enabled }) => [action, enabled]))
  const controlActionSignature = getActionSignature()
  publishActionSignature.current = () => {
    const nextSignature = getActionSignature()
    if (actionSignature.current === nextSignature) return
    actionSignature.current = nextSignature
    controlRegistration.current?.lease.changed()
  }
  controlRunner.current = (request, isCurrent) => {
    if (!isCurrent()) return
    switch (request.action) {
      case 'submit':
        requireNoCreationControlValue(request)
        void submit(isCurrent)
        return
      case 'refresh-eligibility':
        requireNoCreationControlValue(request)
        void refreshEligibility(isCurrent)
        return
      case 'open-result':
        requireNoCreationControlValue(request)
        void openResult(isCurrent)
        return
      case 'generate':
        requireNoCreationControlValue(request)
        void generateDetails(isCurrent)
        return
      case 'stop-generation':
        requireNoCreationControlValue(request)
        void stopGeneration(isCurrent)
        return
      case 'base-set': {
        const value = requireCreationControlValue(request, 'base')
        if (typeof value.base !== 'string') throw new Error('Invalid creation action value.')
        setBaseValue(value.base, isCurrent)
        return
      }
      case 'stack-set': {
        const value = requireCreationControlValue(request, 'enabled')
        if (typeof value.enabled !== 'boolean') throw new Error('Invalid creation action value.')
        void createStack(value.enabled, isCurrent)
        return
      }
      default:
        throw new Error('Unknown creation action.')
    }
  }
  useLayoutEffect(() => {
    const registration: ReviewsUiControlRegistration = {
      surface: CREATE_VIEW,
      slot: 'creation',
      target: controlTarget,
      actions: () => getControlActions(),
      run: (request, isCurrent) => {
        if (!isCurrent() || controlSession.current !== sessionIdentity) return
        controlRunner.current(request, () => isCurrent() && controlSession.current === sessionIdentity)
      }
    }
    const lease = registerReviewsUiControl(props.context, registration)
    const currentLease = { target: controlTarget, session: sessionIdentity, lease }
    controlRegistration.current = currentLease
    actionSignature.current = getActionSignature()
    setControlLeaseState({ target: controlTarget, generation: lease.generation })
    return () => {
      if (controlRegistration.current === currentLease) controlRegistration.current = null
      lease.dispose()
      setControlLeaseState((current) => current?.target === controlTarget && current.generation === lease.generation ? null : current)
    }
  }, [props.context, controlTarget, sessionIdentity])
  useEffect(() => {
    publishActionSignature.current()
  }, [controlActionSignature])
  const requestCreationControl = (action: CreationControlAction, value?: Record<string, unknown>) => {
    const lease = controlRegistration.current
    const targetIsCurrent = targetGuard()
    const isCurrent = () => targetIsCurrent() && lease !== null &&
      controlRegistration.current === lease && lease.target === controlTarget && lease.session === sessionIdentity
    if (!lease || !isCurrent()) return
    const request: ReviewsUiControlRequest = {
      target: lease.target,
      generation: lease.lease.generation,
      action,
      ...(value === undefined ? {} : { value })
    }
    void requestReviewsUiControl(props.context, request)
      .then((result: ReviewsUiControlResult) => {
        if (!isCurrent()) return
        if (!result.delivered && result.reason === 'target-unavailable') {
          setLocalError('The creation control is no longer available.')
        }
      })
      .catch((error: unknown) => {
        if (isCurrent()) setLocalError(errorText(error))
      })
  }
  const controlMetadata = controlLeaseState?.target === controlTarget
    ? {
      'data-review-control-target': controlLeaseState.target,
      'data-review-control-generation': String(controlLeaseState.generation)
    }
    : {}
  const isControlEnabled = (action: CreationControlAction) =>
    getControlActions().find((item) => item.action === action)?.enabled === true
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    requestCreationControl('submit')
  }

  if (!worktree) {
    return <section className="ui-stack" aria-label="Create pull request" {...controlMetadata}>
      <SectionHeader title="Create pull request" />
      <EmptyState message="Select a Git worktree before creating a pull request." />
    </section>
  }

  if (!currentTarget || creation.loading) {
    const confirming = creation.loading || confirmationPending
    const confirmationError = localError ?? creation.error ?? (!confirming ? 'The current worktree and branch could not be confirmed.' : null)
    return <section className="ui-stack" aria-label="Create pull request" aria-busy={confirming} {...controlMetadata}>
      <SectionHeader title="Create pull request" />
      {confirmationError
        ? <InlineError message={confirmationError} action={!currentTarget ? { label: 'Retry confirmation', onAction: () => requestCreationControl('refresh-eligibility') } : undefined} />
        : <div role="status" aria-live="polite"><NoticeLine>Confirming this worktree and its current branch…</NoticeLine></div>}
    </section>
  }

  return <main className="ui-stack" aria-label="Create pull request" aria-busy={creation.submitting || generationRunning || saving || stackSaving} {...controlMetadata}>
    <header className="ui-stack">
      <SectionHeader title="Create pull request" />
      <p>Worktree <strong>{worktree}</strong> · <code>{creation.head || 'No current branch'}</code></p>
    </header>

    {stateErrors.map((message) => <InlineError key={message} message={message} />)}
    {stackLookupError && <InlineError message={`Stack capability could not be confirmed: ${stackLookupError}`} />}
    {resultReview && <section className="ui-stack" aria-live="polite">
      <strong>{result?.status === 'already_exists' ? 'Pull request already exists.' : 'Pull request created.'}</strong>
      <p>{resultNumber === null ? 'The review identity could not be shown.' : `Pull request #${resultNumber}`}{resultUrl ? ` · ${resultUrl}` : ''}</p>
      <Button variant="primary" disabled={!isControlEnabled('open-result')} onClick={() => requestCreationControl('open-result')}>Open review</Button>
    </section>}

    <form className="ui-stack" onSubmit={onSubmit}>
      <div className="ui-stack">
        <TextField
          id="review-base"
          label="Base branch"
          type="search"
          list="review-base-options"
          value={base}
          aria-label="Search remote base branches"
          help={`Choose a remote branch different from ${creation.head || 'the current branch'}.`}
          error={baseField.error ?? undefined}
          disabled={creation.submitting || saving || stackSaving || generationRunning || submitLock.current?.isCurrent()}
          onChange={(event) => { baseField.hold(event.target.value); setLocalError(null) }}
          onBlur={() => requestCreationControl('base-set', { base: baseField.value })}
        />
        <datalist id="review-base-options">
          {creation.bases.map((branch) => <option key={branch} value={branch} />)}
        </datalist>
      </div>
      {creation.bases.length === 0 && !creation.loading && !creation.error &&
        <div role="status" aria-live="polite"><EmptyState message="No remote base branches are available." /></div>}

      <TextField
        id="review-title"
        label="Title"
        value={title}
        placeholder="Short summary"
        error={titleField.error ?? undefined}
        disabled={creation.submitting || saving || stackSaving || generationRunning || submitLock.current?.isCurrent()}
        onChange={(event) => {
          titleField.edit(event.target.value)
          setLocalError(null)
        }}
      />

      <FormRow label="Description" htmlFor="review-body" error={bodyField.error ?? undefined}>
        <textarea
          id="review-body"
          className="ui-text-field__input"
          value={body}
          rows={10}
          placeholder="What changed and why?"
          disabled={creation.submitting || saving || stackSaving || generationRunning || submitLock.current?.isCurrent()}
          onChange={(event) => {
            bodyField.edit(event.target.value)
            setLocalError(null)
          }}
          onKeyDown={onBodyKeyDown}
        />
      </FormRow>
      <small className="ui-text-muted">Use Cmd+Enter (macOS) or Ctrl+Enter to submit.</small>

      <fieldset className="ui-stack" disabled={creation.submitting || saving || stackSaving || generationRunning || submitLock.current?.isCurrent()}>
        <legend>Creation options</legend>
        <FormRow label="Create as draft" htmlFor="review-create-draft" error={draftField.error ?? undefined}>
          <input id="review-create-draft" type="checkbox" style={{ accentColor: 'var(--ui-accent)' }} checked={draft} onChange={(event) => {
            draftField.edit(event.target.checked)
            setLocalError(null)
          }} />
        </FormRow>
        <FormRow label="Use repository pull-request template when the description is empty" htmlFor="review-use-template" error={templateField.error ?? undefined}>
          <input id="review-use-template" type="checkbox" style={{ accentColor: 'var(--ui-accent)' }} checked={useTemplate} onChange={(event) => {
            templateField.edit(event.target.checked)
            setLocalError(null)
          }} />
        </FormRow>
        {stackSupported && stackParentNumber !== null && <FormRow label={`Create pull request in stack with #${stackParentNumber}`} htmlFor="review-create-stack">
          <input id="review-create-stack" type="checkbox" style={{ accentColor: 'var(--ui-accent)' }} checked={stackEnabled} disabled={!isControlEnabled('stack-set')} onChange={(event) => requestCreationControl('stack-set', { enabled: event.target.checked })} />
        </FormRow>}
        {!stackSupported && <small>Stacked pull requests are available only for supported GitHub.com repositories.</small>}
      </fieldset>

      <div className="ui-cluster">
        <Button disabled={!isControlEnabled('generate')} onClick={() => requestCreationControl('generate')}>{generationRunning ? 'Generating…' : 'Generate PR details with AI'}</Button>
        {generationRunning && <Button variant="destructive" aria-label="Stop generating pull-request details" disabled={!isControlEnabled('stop-generation')} onClick={() => requestCreationControl('stop-generation')}>Stop</Button>}
        <Button disabled={!isControlEnabled('refresh-eligibility')} onClick={() => requestCreationControl('refresh-eligibility')}>Refresh eligibility</Button>
        <Button variant="primary" type="submit" disabled={!canSubmit || !isControlEnabled('submit')} title={disabledReason ?? undefined}>
          {creation.submitting || saving ? 'Creating…' : stackEnabled ? `${draft ? 'Create draft' : 'Create'} PR in stack` : needsPush ? 'Push & Create PR' : 'Create PR'}
        </Button>
      </div>
      {disabledReason && <p className="ui-text-muted" role="status">{disabledReason}</p>}
      {blockerMessage && needsPush && <p role="status">{blockerMessage}</p>}
    </form>
  </main>
}
