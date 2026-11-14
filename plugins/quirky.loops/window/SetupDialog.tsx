import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Button, Dialog, EmptyState, FormRow, InlineError, NoticeLine, SelectField, TextArea, TextField } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import type { LoopSnapshot } from '../src/types'
import { ConfigFields, initialDraft, validateDraft } from './config-form'
import type { LoopDraft, SetupDialogProps, SurfaceHandle } from './contracts'

type AgentChoice = { id: 'claude' | 'codex'; label: string; isDefault: boolean }
type WorkspaceChoice = { id: string; kind: 'git' | 'folder'; path: string }
type SetupRead = {
  draft: LoopDraft
  errors: Record<string, string>
  busy: boolean
  agents: AgentChoice[]
  workspaceKind: 'git' | 'folder' | null
  showCost: boolean
  warning: string | null
  loading: boolean
  loadError: string | null
  error: string | null
  valid: boolean
  canStart: boolean
  alreadyCreated: boolean
  createdLoopId: string | null
  group: string | null
}

type UiState = {
  draft: LoopDraft
  agents: AgentChoice[]
  workspace: WorkspaceChoice | null
  workspaceLoading: boolean
  agentsLoading: boolean
  loopsLoading: boolean
  loadErrors: Record<string, string>
  warning: string | null
  busy: boolean
  serverError: string | null
  alreadyCreated: boolean
  createdLoop: LoopSnapshot | null
  queueComposer: string
}
type DraftOverlay<T> = { version: object; value: T; acknowledged: boolean }

const presetSession = (preset: LoopDraft['preset']): LoopDraft['sessionPolicy'] =>
  preset === 'until-done' ? 'fresh' : 'continue'
const presetPacing = (preset: LoopDraft['preset']): LoopDraft['pacingKind'] =>
  preset === 'interval' ? 'interval' : 'on-idle'

const runningLoopMessage = 'This workspace already has a running loop. A second loop edits the same files at the same time.'
const presetName = (draft: LoopDraft): string => {
  const source = draft.preset === 'queue' ? draft.queueItems[0] ?? '' : draft.prompt
  const firstLine = source.split(/\r?\n/, 1)[0]?.trim().slice(0, 48) ?? ''
  if (draft.name.trim() !== '') return draft.name.trim()
  if (firstLine !== '') return firstLine
  if (draft.preset === 'interval') return 'On an interval'
  return draft.preset === 'queue' ? 'Queue' : 'Until done'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  if (typeof error === 'string' && error.trim() !== '') return error
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim() !== '') return error.message
  return 'An unexpected error occurred.'
}

function failIfUnknownKeys(params: Record<string, unknown>, allowed: readonly string[], action: string): void {
  const unknown = Object.keys(params).find((key) => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`Unsupported parameter "${unknown}" for setup action "${action}".`)
}

function parseWorkspace(value: unknown): WorkspaceChoice {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim() === '' ||
    (value.kind !== 'git' && value.kind !== 'folder') || typeof value.path !== 'string') {
    throw new Error('The workspace lookup returned an invalid workspace.')
  }
  return { id: value.id, kind: value.kind, path: value.path }
}

function parseAgents(value: unknown): { agents: AgentChoice[]; preferred: AgentChoice | undefined } {
  if (!isRecord(value) || !Array.isArray(value.agents)) throw new Error('The agent list returned an invalid response.')
  const defaultAgent = typeof value.defaultAgent === 'string' ? value.defaultAgent : ''
  const available: AgentChoice[] = []
  for (const item of value.agents) {
    if (!isRecord(item) || (item.id !== 'claude' && item.id !== 'codex') ||
      item.installed !== true || item.enabled !== true) continue
    available.push({
      id: item.id,
      label: typeof item.label === 'string' && item.label.trim() !== '' ? item.label : item.id,
      isDefault: item.id === defaultAgent || item.isDefault === true
    })
  }
  available.sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
  const preferred = available.find((agent) => agent.id === defaultAgent) ?? available.find((agent) => agent.isDefault) ?? available[0]
  return { agents: available, preferred }
}

function parseLoopList(value: unknown, worktreeId: string): { running: boolean } {
  if (!Array.isArray(value)) throw new Error('The loop list returned an invalid response.')
  return {
    running: value.some((item) =>
      isRecord(item) && item.worktreeId === worktreeId && (item.state === 'running' || item.state === 'needs-you')
    )
  }
}

function parseCreatedLoop(value: unknown): LoopSnapshot {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' ||
    typeof value.worktreeId !== 'string' || (value.state !== 'running' && value.state !== 'needs-you' &&
      value.state !== 'paused' && value.state !== 'completed' && value.state !== 'stopped')) {
    throw new Error('The loop was created, but its snapshot was invalid.')
  }
  return value as unknown as LoopSnapshot
}

function presetDefault(draft: LoopDraft): LoopDraft {
  return {
    ...draft,
    pacingKind: presetPacing(draft.preset),
    sessionPolicy: presetSession(draft.preset)
  }
}

function validatePatch(value: unknown, agents: AgentChoice[]): Partial<LoopDraft> {
  if (!isRecord(value)) throw new Error('Setup update requires a patch object.')
  const stringFields: (keyof LoopDraft)[] = [
    'name', 'prompt', 'intervalMinutes', 'maxIterations', 'checkCommand', 'checkTimeout',
    'evaluatorCondition', 'maxActiveMinutes', 'maxCostUsd', 'protectedPaths'
  ]
  const booleanFields: (keyof LoopDraft)[] = ['repeatQueue', 'noProgress', 'checkpointCommits', 'askBeforeNext', 'resumeAtLimitReset']
  const enumFields: (keyof LoopDraft)[] = ['agent', 'preset', 'pacingKind', 'anchor', 'sessionPolicy', 'checkWhen']
  const allowed = [...stringFields, ...booleanFields, ...enumFields]
  failIfUnknownKeys(value, allowed, 'update')
  const patch: Partial<LoopDraft> = {}
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!allowed.includes(key as keyof LoopDraft)) throw new Error(`Unsupported setup field "${key}".`)
    if (stringFields.includes(key as keyof LoopDraft)) {
      if (typeof fieldValue !== 'string') throw new Error(`Setup field "${key}" must be a string.`)
      Object.assign(patch, { [key]: fieldValue })
      continue
    }
    if (booleanFields.includes(key as keyof LoopDraft)) {
      if (typeof fieldValue !== 'boolean') throw new Error(`Setup field "${key}" must be a boolean.`)
      Object.assign(patch, { [key]: fieldValue })
      continue
    }
    if (key === 'agent') {
      if (fieldValue !== 'claude' && fieldValue !== 'codex') throw new Error('Choose Claude or Codex as the loop agent.')
      if (!agents.some((agent) => agent.id === fieldValue)) throw new Error('That agent is not installed and enabled.')
      patch.agent = fieldValue
    } else if (key === 'preset') {
      if (fieldValue !== 'until-done' && fieldValue !== 'interval' && fieldValue !== 'queue') {
        throw new Error('Choose a supported loop preset.')
      }
      patch.preset = fieldValue
    } else if (key === 'anchor') {
      if (fieldValue !== 'from-end' && fieldValue !== 'wall-clock') throw new Error('Choose a supported interval anchor.')
      patch.anchor = fieldValue
    } else if (key === 'sessionPolicy') {
      if (fieldValue !== 'fresh' && fieldValue !== 'continue') throw new Error('Choose a supported session policy.')
      patch.sessionPolicy = fieldValue
    } else if (key === 'checkWhen') {
      if (fieldValue !== 'every-iteration' && fieldValue !== 'on-claim') throw new Error('Choose a supported check schedule.')
      patch.checkWhen = fieldValue
    } else if (key === 'pacingKind') {
      if (fieldValue !== 'on-idle' && fieldValue !== 'interval') throw new Error('Choose a supported pacing option.')
      patch.pacingKind = fieldValue
    }
  }
  return patch
}

function applyDraftPatch(current: LoopDraft, value: unknown, agents: AgentChoice[]): LoopDraft {
  const patch = validatePatch(value, agents)
  const changedPreset = patch.preset !== undefined && patch.preset !== current.preset
  const next = { ...current, ...patch, pacingKind: presetPacing(patch.preset ?? current.preset) }
  return changedPreset ? presetDefault(next) : next
}

function replaceQueueItemBody(items: readonly string[], index: number, body: string): string[] {
  return items.map((itemBody, itemIndex) => itemIndex === index ? body : itemBody)
}

function sameQueueItems(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((body, index) => body === right[index])
}


function matchesDraftOverlay(draft: LoopDraft, overlay: Partial<LoopDraft>): boolean {
  return Object.entries(overlay).every(([key, value]) => key === 'queueItems' && Array.isArray(value)
    ? sameQueueItems(draft.queueItems, value)
    : Object.is(draft[key as keyof LoopDraft], value))
}

export function SetupDialog(props: SetupDialogProps) {
  const checkboxId = useId()
  const [draft, setDraft] = useState<LoopDraft>(() => initialDraft())
  const [agents, setAgents] = useState<AgentChoice[]>([])
  const [workspace, setWorkspace] = useState<WorkspaceChoice | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(true)
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [loopsLoading, setLoopsLoading] = useState(true)
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({})
  const [warning, setWarning] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [alreadyCreated, setAlreadyCreated] = useState(false)
  const [createdLoop, setCreatedLoop] = useState<LoopSnapshot | null>(null)
  const [queueComposer, setQueueComposer] = useState('')
  const [optimisticDraft, setOptimisticDraft] = useState<DraftOverlay<Partial<LoopDraft>> | null>(null)
  const [optimisticQueueItems, setOptimisticQueueItems] = useState<DraftOverlay<string[]> | null>(null)
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve())
  const setupGenerationRef = useRef(0)
  const draftRef = useRef(draft)
  const agentsRef = useRef(agents)
  const workspaceRef = useRef(workspace)
  const busyRef = useRef(busy)
  const alreadyCreatedRef = useRef(alreadyCreated)
  const propsRef = useRef(props)
  const createdLoopRef = useRef(createdLoop)
  const workspaceLoadingRef = useRef(workspaceLoading)
  const agentsLoadingRef = useRef(agentsLoading)
  const loopsLoadingRef = useRef(loopsLoading)
  const loadErrorsRef = useRef(loadErrors)
  const warningRef = useRef(warning)
  const serverErrorRef = useRef(serverError)
  const optimisticDraftRef = useRef(optimisticDraft)
  const optimisticQueueItemsRef = useRef(optimisticQueueItems)
  const unsyncedDraftRef = useRef(false)
  const showCost = workspace !== null && agents.some((agent) => agent.id === draft.agent)
  const validation = useMemo(() => validateDraft(draft, {
    workspaceKind: workspace?.kind ?? 'folder',
    showCost
  }), [draft, showCost, workspace?.kind])
  const displayDraft = useMemo<LoopDraft>(() => ({
    ...draft,
    ...(optimisticDraft?.value ?? {}),
    queueItems: optimisticQueueItems?.value ?? optimisticDraft?.value.queueItems ?? draft.queueItems
  }), [draft, optimisticDraft, optimisticQueueItems])
  const displayShowCost = workspace !== null && agents.some((agent) => agent.id === displayDraft.agent)
  const displayValidation = useMemo(() => validateDraft(displayDraft, {
    workspaceKind: workspace?.kind ?? 'folder',
    showCost: displayShowCost
  }), [displayDraft, displayShowCost, workspace?.kind])
  const hasDraftMismatch = optimisticDraft !== null && Object.entries(optimisticDraft.value)
    .some(([key, value]) => !Object.is(draft[key as keyof LoopDraft], value))
  const hasQueueMismatch = optimisticQueueItems !== null && !sameQueueItems(draft.queueItems, optimisticQueueItems.value)
  const hasUnsyncedDraft = hasDraftMismatch || hasQueueMismatch
  const loading = workspaceLoading || agentsLoading || loopsLoading
  const loadError = Object.entries(loadErrors).map(([source, message]) => `${source}: ${message}`).join('\n') || null
  const canStart = validation.input !== null && workspace !== null && !workspaceLoading && !agentsLoading &&
    !loopsLoading && agents.some((agent) => agent.id === draft.agent) && !busy && !alreadyCreated && !hasUnsyncedDraft
  draftRef.current = draft
  agentsRef.current = agents
  workspaceRef.current = workspace
  busyRef.current = busy
  alreadyCreatedRef.current = alreadyCreated
  createdLoopRef.current = createdLoop
  workspaceLoadingRef.current = workspaceLoading
  agentsLoadingRef.current = agentsLoading
  loopsLoadingRef.current = loopsLoading
  loadErrorsRef.current = loadErrors
  warningRef.current = warning
  optimisticDraftRef.current = optimisticDraft
  optimisticQueueItemsRef.current = optimisticQueueItems
  unsyncedDraftRef.current = hasUnsyncedDraft
  serverErrorRef.current = serverError
  propsRef.current = props

  const setServerErrorState = useCallback((next: string | null) => {
    serverErrorRef.current = next
    setServerError(next)
  }, [])
  const setLoadErrorState = useCallback((source: string, message: string) => {
    const next = { ...loadErrorsRef.current, [source]: message }
    loadErrorsRef.current = next
    setLoadErrors(next)
  }, [])
  const setWarningState = useCallback((next: string | null) => {
    warningRef.current = next
    setWarning(next)
  }, [])
  const commitDraft = useCallback((next: LoopDraft) => {
    draftRef.current = next
    setDraft(next)
    setServerErrorState(null)
  }, [setServerErrorState])

  const setBusyState = useCallback((next: boolean) => {
    busyRef.current = next
    setBusy(next)
  }, [])

  const refreshUnsyncedDraft = useCallback((): boolean => {
    const draftOverlay = optimisticDraftRef.current
    const queueOverlay = optimisticQueueItemsRef.current
    const unsynced = (draftOverlay !== null && !matchesDraftOverlay(draftRef.current, draftOverlay.value)) ||
      (queueOverlay !== null && !sameQueueItems(draftRef.current.queueItems, queueOverlay.value))
    unsyncedDraftRef.current = unsynced
    return unsynced
  }, [])

  const updateDraft = useCallback((patchValue: unknown) => {
    commitDraft(applyDraftPatch(draftRef.current, patchValue, agentsRef.current))
  }, [commitDraft])

  const updateQueue = useCallback((operation: 'add' | 'edit' | 'move' | 'remove', params: Record<string, unknown>) => {
    const current = draftRef.current
    if (current.preset !== 'queue') throw new Error('Queue actions require the queue preset.')
    if (operation === 'add') {
      failIfUnknownKeys(params, ['body'], 'queue-add')
      if (typeof params.body !== 'string') throw new Error('Queue add requires a text body.')
      commitDraft({ ...current, queueItems: [...current.queueItems, params.body] })
      return
    }
    failIfUnknownKeys(params, operation === 'move' ? ['index', 'position'] : ['index', ...(operation === 'edit' ? ['body'] : [])], `queue-${operation}`)
    const index = params.index
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= current.queueItems.length) {
      throw new Error('Queue item index is out of range.')
    }
    if (operation === 'edit') {
      const body = params.body
      if (typeof body !== 'string') throw new Error('Queue edit requires a text body.')
      commitDraft({ ...current, queueItems: replaceQueueItemBody(current.queueItems, index, body) })
      return
    }
    if (operation === 'remove') {
      commitDraft({ ...current, queueItems: current.queueItems.filter((_, itemIndex) => itemIndex !== index) })
      return
    }
    const direction = params.position
    const target = direction === 'up'
      ? index - 1
      : direction === 'down'
        ? index + 1
        : typeof direction === 'number' && Number.isInteger(direction)
          ? direction
          : null
    if (target === null) throw new Error('Queue move position must be an integer, up, or down.')
    if (target < 0 || target >= current.queueItems.length) {
      if (direction === 'up' || direction === 'down') return
      throw new Error('Queue destination is out of range.')
    }
    if (target === index) return
    const queueItems = [...current.queueItems]
    const moved = queueItems.splice(index, 1)[0]
    if (moved === undefined) throw new Error('Queue item index is out of range.')
    queueItems.splice(target, 0, moved)
    commitDraft({ ...current, queueItems })
  }, [commitDraft])

  const stageDraftUpdate = (patch: Partial<LoopDraft>): DraftOverlay<Partial<LoopDraft>> => {
    const previous = optimisticDraftRef.current?.value ?? {}
    const baseDraft = {
      ...draftRef.current,
      ...previous,
      queueItems: optimisticQueueItemsRef.current?.value ?? draftRef.current.queueItems
    }
    const nextDraft = applyDraftPatch(baseDraft, patch, agentsRef.current)
    const value: Partial<LoopDraft> = { ...previous, ...patch }
    if (patch.preset !== undefined || patch.pacingKind !== undefined) value.pacingKind = nextDraft.pacingKind
    if (patch.preset !== undefined || patch.sessionPolicy !== undefined) value.sessionPolicy = nextDraft.sessionPolicy
    const overlay = { version: {}, value, acknowledged: false }
    optimisticDraftRef.current = overlay
    setOptimisticDraft(overlay)
    refreshUnsyncedDraft()
    return overlay
  }

  const stageQueueItemEdit = (index: number, body: string): DraftOverlay<string[]> => {
    const items = optimisticQueueItemsRef.current?.value ?? draftRef.current.queueItems
    const overlay = {
      version: {},
      value: replaceQueueItemBody(items, index, body),
      acknowledged: false
    }
    optimisticQueueItemsRef.current = overlay
    setOptimisticQueueItems(overlay)
    refreshUnsyncedDraft()
    return overlay
  }

  const reconcileQueueOverlay = useCallback((
    action: 'queue-add' | 'queue-edit' | 'queue-move' | 'queue-remove',
    params: Record<string, unknown>
  ) => {
    const current = optimisticQueueItemsRef.current
    if (current === null) return
    let value = current.value
    if (action === 'queue-add') {
      if (typeof params.body !== 'string') return
      value = [...value, params.body]
    } else {
      const index = params.index
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= value.length) return
      if (action === 'queue-edit') {
        if (typeof params.body !== 'string') return
        value = replaceQueueItemBody(value, index, params.body)
      } else if (action === 'queue-remove') {
        value = value.filter((_, itemIndex) => itemIndex !== index)
      } else {
        const direction = params.position
        const target = direction === 'up'
          ? index - 1
          : direction === 'down'
            ? index + 1
            : typeof direction === 'number' && Number.isInteger(direction)
              ? direction
              : null
        if (target === null || target < 0 || target >= value.length || target === index) return
        const next = [...value]
        const moved = next.splice(index, 1)[0]
        if (moved === undefined) return
        next.splice(target, 0, moved)
        value = next
      }
    }
    if (sameQueueItems(current.value, value)) return
    const next = { ...current, value }
    optimisticQueueItemsRef.current = next
    setOptimisticQueueItems(next)
    refreshUnsyncedDraft()
  }, [refreshUnsyncedDraft])

  const stageAdvanced = (open: boolean): DraftOverlay<Partial<LoopDraft>> => {
    const overlay = {
      version: {},
      value: { ...(optimisticDraftRef.current?.value ?? {}), advanced: open },
      acknowledged: false
    }
    optimisticDraftRef.current = overlay
    setOptimisticDraft(overlay)
    refreshUnsyncedDraft()
    return overlay
  }

  const acknowledgeDraftOverlay = (version: object) => {
    const current = optimisticDraftRef.current
    if (current?.version !== version) return
    const next = { ...current, acknowledged: true }
    optimisticDraftRef.current = next
    setOptimisticDraft(next)
    refreshUnsyncedDraft()
  }

  const acknowledgeQueueOverlay = (version: object) => {
    const current = optimisticQueueItemsRef.current
    if (current?.version !== version) return
    const next = { ...current, acknowledged: true }
    optimisticQueueItemsRef.current = next
    setOptimisticQueueItems(next)
    refreshUnsyncedDraft()
  }

  const createLoop = useCallback(async (): Promise<unknown> => {
    if (busyRef.current) return { ok: false, busy: true }
    if (unsyncedDraftRef.current) throw new Error('Wait for pending setup edits to finish before starting.')
    if (alreadyCreatedRef.current) return { ok: false, alreadyCreated: true }
    const currentDraft = draftRef.current
    const currentWorkspace = workspaceRef.current
    const currentShowCost = currentWorkspace !== null && agentsRef.current.some((agent) => agent.id === currentDraft.agent)
    const checked = validateDraft(currentDraft, {
      workspaceKind: currentWorkspace?.kind ?? 'folder',
      showCost: currentShowCost
    })
    if (checked.input === null || currentWorkspace === null || !agentsRef.current.some((agent) => agent.id === currentDraft.agent)) {
      return { ok: false, errors: checked.errors }
    }
    if (workspaceLoadingRef.current || agentsLoadingRef.current || loopsLoadingRef.current) return { ok: false, loading: true }

    setBusyState(true)
    setServerErrorState(null)
    let requestCreated = false
    try {
      const loopResult = await propsRef.current.context.call('quirky.loops/create', {
        worktreeId: currentWorkspace.id,
        ...checked.input
      })
      requestCreated = true
      alreadyCreatedRef.current = true
      setAlreadyCreated(true)
      const loop = parseCreatedLoop(loopResult)
      createdLoopRef.current = loop
      setCreatedLoop(loop)
      try {
        await propsRef.current.onCreated(loop)
      } catch (error) {
        const message = messageOf(error)
        setServerErrorState(`Loop started, but its tab could not be opened: ${message}`)
        propsRef.current.context.toast('Loop started, but the tab could not be opened.', message)
        return { ok: false, alreadyCreated: true, error: message }
      }
      propsRef.current.onClose()
      return { ok: true, loop }
    } catch (error) {
      const message = messageOf(error)
      if (requestCreated) {
        setServerErrorState(`Loop started, but its tab could not be opened: ${message}`)
        propsRef.current.context.toast('Loop started, but the tab could not be opened.', message)
        return { ok: false, alreadyCreated: true, error: message }
      }
      setServerErrorState(message)
      propsRef.current.context.toast('Could not start the loop.', message)
      return { ok: false, error: message }
    } finally {
      setBusyState(false)
    }
  }, [setBusyState, setServerErrorState])
  const readSurface = useCallback((): Record<string, unknown> => {
    const currentDraft = draftRef.current
    const currentWorkspace = workspaceRef.current
    const currentAgents = agentsRef.current
    const currentShowCost = currentWorkspace !== null && currentAgents.some((agent) => agent.id === currentDraft.agent)
    const currentValidation = validateDraft(currentDraft, {
      workspaceKind: currentWorkspace?.kind ?? 'folder',
      showCost: currentShowCost
    })
    const currentLoading = workspaceLoadingRef.current || agentsLoadingRef.current || loopsLoadingRef.current
    const currentLoadError = Object.entries(loadErrorsRef.current)
      .map(([source, message]) => `${source}: ${message}`)
      .join('\n') || null
    return {
      draft: { ...currentDraft, queueItems: [...currentDraft.queueItems] },
      errors: { ...currentValidation.errors },
      busy: busyRef.current,
      agents: currentAgents.map((agent) => ({ ...agent })),
      workspaceKind: currentWorkspace?.kind ?? null,
      showCost: currentShowCost,
      warning: warningRef.current,
      loading: currentLoading,
      loadError: currentLoadError,
      error: serverErrorRef.current,
      valid: currentValidation.config !== null,
      canStart: currentValidation.input !== null && currentWorkspace !== null && !currentLoading &&
        currentAgents.some((agent) => agent.id === currentDraft.agent) && !busyRef.current && !alreadyCreatedRef.current &&
        !unsyncedDraftRef.current,
      alreadyCreated: alreadyCreatedRef.current,
      createdLoopId: createdLoopRef.current?.id ?? null,
      group: propsRef.current.group ?? null
    }
  }, [])

  const dispatch = useCallback(async (action: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (!isRecord(params)) throw new Error('Setup action parameters must be an object.')
    if (action === 'update') {
      failIfUnknownKeys(params, ['patch'], action)
      if (!Object.hasOwn(params, 'patch')) throw new Error('Setup update requires a patch.')
      updateDraft(params.patch)
      return readSurface()
    }
    if (action === 'queue-add' || action === 'queue-edit' || action === 'queue-move' || action === 'queue-remove') {
      updateQueue(action.slice('queue-'.length) as 'add' | 'edit' | 'move' | 'remove', params)
      reconcileQueueOverlay(action, params)
      return readSurface()
    }
    if (action === 'advanced') {
      failIfUnknownKeys(params, ['open'], action)
      const hasOpen = Object.hasOwn(params, 'open')
      if (hasOpen && typeof params.open !== 'boolean') throw new Error('Advanced open must be a boolean.')
      const open = hasOpen ? params.open === true : !draftRef.current.advanced
      const next = { ...draftRef.current, advanced: open }
      draftRef.current = next
      setDraft(next)
      setServerErrorState(null)
      return readSurface()
    }
    if (action === 'start') {
      failIfUnknownKeys(params, [], action)
      return createLoop()
    }
    if (action === 'cancel') {
      failIfUnknownKeys(params, [], action)
      const canCancel = !busyRef.current
      if (canCancel) propsRef.current.onClose()
      return { ok: canCancel }
    }
    throw new Error(`Unknown setup action "${action}".`)
  }, [createLoop, readSurface, reconcileQueueOverlay, setServerErrorState, updateDraft, updateQueue])

  const stateForConsumer = useMemo<SetupRead>(() => ({
    draft: { ...draft, queueItems: [...draft.queueItems] },
    errors: { ...validation.errors },
    busy,
    agents: agents.map((agent) => ({ ...agent })),
    workspaceKind: workspace?.kind ?? null,
    showCost,
    warning,
    loading,
    loadError,
    error: serverError,
    valid: validation.config !== null,
    canStart,
    alreadyCreated,
    createdLoopId: createdLoop?.id ?? null,
    group: props.group ?? null
  }), [alreadyCreated, agents, busy, canStart, createdLoop?.id, draft, loadError, loading, props.group, serverError, showCost, validation.config, validation.errors, warning, workspace?.kind])

  useEffect(() => {
    let current = true
    setupGenerationRef.current += 1
    optimisticDraftRef.current = null
    commandQueueRef.current = Promise.resolve()
    optimisticQueueItemsRef.current = null
    unsyncedDraftRef.current = false
    setOptimisticDraft(null)
    setOptimisticQueueItems(null)
    setQueueComposer('')
    workspaceLoadingRef.current = true
    agentsLoadingRef.current = true
    loopsLoadingRef.current = true
    loadErrorsRef.current = {}
    warningRef.current = null
    workspaceRef.current = null
    agentsRef.current = []
    setWorkspaceLoading(true)
    setAgentsLoading(true)
    setLoopsLoading(true)
    setLoadErrors({})
    setWarning(null)
    setWorkspace(null)
    setAgents([])
    const loadWorkspaceAndAgents = async () => {
      const [workspaceResult, agentsResult] = await Promise.allSettled([
        propsRef.current.context.call('quirky.worktree/show', { worktree: propsRef.current.workspace }),
        propsRef.current.context.call('quirky.agents/list', {})
      ])
      if (!current) return
      let resolvedWorkspace: WorkspaceChoice | null = null
      if (workspaceResult.status === 'fulfilled') {
        try {
          resolvedWorkspace = parseWorkspace(workspaceResult.value)
          workspaceRef.current = resolvedWorkspace
          setWorkspace(resolvedWorkspace)
        } catch (error) {
          setLoadErrorState('workspace', messageOf(error))
        }
      } else {
        setLoadErrorState('workspace', messageOf(workspaceResult.reason))
      }
      if (agentsResult.status === 'fulfilled') {
        try {
          const result = parseAgents(agentsResult.value)
          agentsRef.current = result.agents
          setAgents(result.agents)
          if (result.preferred !== undefined) {
            const next = { ...draftRef.current, agent: result.preferred.id }
            draftRef.current = next
            setDraft(next)
          }
        } catch (error) {
          setLoadErrorState('agents', messageOf(error))
        }
      } else {
        setLoadErrorState('agents', messageOf(agentsResult.reason))
      }
      workspaceLoadingRef.current = false
      agentsLoadingRef.current = false
      setWorkspaceLoading(false)
      setAgentsLoading(false)
      if (resolvedWorkspace === null) {
        loopsLoadingRef.current = false
        setLoopsLoading(false)
        return
      }
      try {
        const listing = await propsRef.current.context.call('quirky.loops/list', { worktreeId: resolvedWorkspace.id })
        if (!current) return
        const result = parseLoopList(listing, resolvedWorkspace.id)
        setWarningState(result.running ? runningLoopMessage : null)
      } catch (error) {
        if (current) setLoadErrorState('loops', messageOf(error))
      } finally {
        if (current) {
          loopsLoadingRef.current = false
          setLoopsLoading(false)
        }
      }
    }
    void loadWorkspaceAndAgents()
    return () => {
      current = false
      setupGenerationRef.current += 1
    }
  }, [props.context, props.workspace, setLoadErrorState, setWarningState])

  useEffect(() => {
    props.onHandle({
      read: readSurface,
      dispatch
    } satisfies SurfaceHandle)
    return () => props.onHandle(null)
  }, [dispatch, props.onHandle, readSurface])

  useEffect(() => {
    props.report?.(stateForConsumer)
  }, [props.report, stateForConsumer])

  useEffect(() => {
    const current = optimisticDraftRef.current
    if (current?.acknowledged && matchesDraftOverlay(draft, current.value)) {
      optimisticDraftRef.current = null
      setOptimisticDraft(null)
      const queueOverlay = optimisticQueueItemsRef.current
      unsyncedDraftRef.current = queueOverlay !== null && !sameQueueItems(draft.queueItems, queueOverlay.value)
    }
  }, [draft, optimisticDraft])

  useEffect(() => {
    const current = optimisticQueueItemsRef.current
    if (current?.acknowledged && sameQueueItems(draft.queueItems, current.value)) {
      optimisticQueueItemsRef.current = null
      setOptimisticQueueItems(null)
      const draftOverlay = optimisticDraftRef.current
      unsyncedDraftRef.current = draftOverlay !== null && !matchesDraftOverlay(draft, draftOverlay.value)
    }
  }, [draft.queueItems, optimisticQueueItems])

  const runSetupAction = async (
    action: string,
    params: Record<string, unknown> = {},
    onSuccess?: () => void
  ): Promise<void> => {
    const generation = setupGenerationRef.current
    const execute = async () => {
      if (generation !== setupGenerationRef.current) return
      if (action === 'start' && unsyncedDraftRef.current) {
        setServerErrorState('Wait for pending setup edits to finish before starting.')
        return
      }
      try {
        await propsRef.current.context.executeCommand('command:quirky.loops/setup-action', { action, params })
        if (generation === setupGenerationRef.current) onSuccess?.()
      } catch (error) {
        if (generation === setupGenerationRef.current) setServerErrorState(messageOf(error))
      }
    }
    const orderedWithDraft = action === 'update' || action === 'advanced' || action.startsWith('queue-') || action === 'start'
    if (orderedWithDraft) {
      const pending = commandQueueRef.current.then(execute, execute)
      commandQueueRef.current = pending.then(() => undefined, () => undefined)
      await pending
      return
    }
    await execute()
  }
  const updateDraftFromDom = async (patch: Partial<LoopDraft>) => {
    const overlay = stageDraftUpdate(patch)
    await runSetupAction('update', { patch }, () => acknowledgeDraftOverlay(overlay.version))
  }
  const updateQueueItemFromDom = (index: number, body: string) => {
    const overlay = stageQueueItemEdit(index, body)
    void runSetupAction('queue-edit', { index, body }, () => acknowledgeQueueOverlay(overlay.version))
  }
  const onConfigChange = async (patch: Partial<LoopDraft>) => {
    const { advanced, ...fields } = patch
    if (Object.keys(fields).length > 0) await updateDraftFromDom(fields)
    if (advanced !== undefined) {
      const overlay = stageAdvanced(advanced)
      await runSetupAction('advanced', { open: advanced }, () => acknowledgeDraftOverlay(overlay.version))
    }
  }
  const changeText = (event: ChangeEvent<HTMLTextAreaElement>) => {
    void updateDraftFromDom({ prompt: event.currentTarget.value })
  }
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void runSetupAction('start')
  }
  const canEdit = !busy && !alreadyCreated
  const closeDialog = () => {
    if (canEdit) void runSetupAction('cancel')
  }
  const addQueuePrompt = () => {
    const body = queueComposer
    void runSetupAction('queue-add', { body }, () => {
      const draft = readSurface().draft
      if (!isRecord(draft) || !Array.isArray(draft.queueItems) || draft.queueItems[draft.queueItems.length - 1] !== body) return
      setQueueComposer((current) => current === body ? '' : current)
    })
  }
  const namePlaceholder = presetName(displayDraft)
  const agentLoadError = loadErrors.agents
  const workspaceLoadError = loadErrors.workspace
  const loopLoadError = loadErrors.loops

  return (
    <Dialog
      open
      title="New loop"
      onClose={closeDialog}
      closeOnBackdrop={false}
    >
      <form className="ui-stack" aria-label="New loop" onSubmit={onSubmit}>
        <section className="ui-stack" aria-label="Loop prompt">
          {warning && <NoticeLine><span role="status">{warning}</span></NoticeLine>}
          <TextField
            id="loop-setup-name"
            label="Loop name"
            aria-label="Loop name"
            type="text"
            value={displayDraft.name}
            placeholder={namePlaceholder}
            disabled={!canEdit}
            onChange={(event) => void updateDraftFromDom({ name: event.currentTarget.value })}
          />
          {displayDraft.preset === 'queue' ? (
            <div className="ui-stack" aria-label="Queue prompts">
              {displayDraft.queueItems.map((body, index) => (
                <div className="ui-stack" key={index}>
                  <TextArea
                    id={`loop-queue-item-${index}`}
                    label={`Queue item ${index + 1}`}
                    aria-label={`Queue item ${index + 1}`}
                    value={body}
                    rows={3}
                    disabled={!canEdit}
                    error={displayValidation.errors[`queueItems.${index}`]}
                    onChange={(event) => updateQueueItemFromDom(index, event.currentTarget.value)}
                  />
                  <div className="ui-cluster">
                    <Button type="button" aria-label={`Move queue item ${index + 1} up`} disabled={!canEdit || index === 0} onClick={() => { void runSetupAction('queue-move', { index, position: 'up' }) }}>↑</Button>
                    <Button type="button" aria-label={`Move queue item ${index + 1} down`} disabled={!canEdit || index === displayDraft.queueItems.length - 1} onClick={() => { void runSetupAction('queue-move', { index, position: 'down' }) }}>↓</Button>
                    <Button type="button" variant="destructive" aria-label={`Remove queue item ${index + 1}`} disabled={!canEdit} onClick={() => { void runSetupAction('queue-remove', { index }) }}>Remove</Button>
                  </div>
                </div>
              ))}
              {displayDraft.queueItems.length === 0 && <EmptyState message="Add at least one prompt to the queue." />}
              {displayValidation.errors.queueItems && displayDraft.queueItems.length > 0 && (
                <InlineError message={displayValidation.errors.queueItems} />
              )}
              <div className="ui-stack">
                <TextArea
                  id="loop-queue-new"
                  label="New queue item"
                  aria-label="New queue item"
                  value={queueComposer}
                  rows={3}
                  disabled={!canEdit}
                  onChange={(event) => setQueueComposer(event.currentTarget.value)}
                />
                <Button
                  type="button"
                  disabled={!canEdit}
                  onClick={addQueuePrompt}
                >
                  Add to queue
                </Button>
              </div>
              <FormRow label="Start over when the queue is empty" htmlFor={`${checkboxId}-repeat-queue`}>
                <input
                  id={`${checkboxId}-repeat-queue`}
                  type="checkbox"
                  checked={displayDraft.repeatQueue}
                  disabled={!canEdit}
                  onChange={(event) => void updateDraftFromDom({ repeatQueue: event.currentTarget.checked })}
                />
              </FormRow>
            </div>
          ) : (
            <TextArea
              id="loop-setup-prompt"
              label="Prompt"
              aria-label="Prompt"
              value={displayDraft.prompt}
              disabled={!canEdit}
              error={displayValidation.errors.prompt}
              onChange={changeText}
            />
          )}
        </section>
        <section className="ui-stack" aria-label="Loop configuration">
          {loading && <NoticeLine><span role="status">Loading workspace and agents…</span></NoticeLine>}
          {workspaceLoadError && <InlineError message={`Could not load the workspace: ${workspaceLoadError}`} />}
          {agentLoadError && <InlineError message={`Could not load agents: ${agentLoadError}`} />}
          {loopLoadError && <InlineError message={`Could not check for existing loops: ${loopLoadError}`} />}
          {!agentsLoading && !agentLoadError && agents.length === 0 && (
            <EmptyState message="No installed and enabled Claude or Codex agents are available." />
          )}
          <SelectField
            label="Agent"
            aria-label="Agent"
            value={displayDraft.agent}
            disabled={!canEdit || agentsLoading || agents.length === 0}
            onChange={(event) => void updateDraftFromDom({ agent: event.currentTarget.value as LoopDraft['agent'] })}
          >
            {agents.length === 0 && <option value={displayDraft.agent}>Unavailable</option>}
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
          </SelectField>
          <ConfigFields
            draft={displayDraft}
            onChange={onConfigChange}
            errors={displayValidation.errors}
            workspaceKind={workspace?.kind ?? 'folder'}
            showCost={displayShowCost}
            disabled={!canEdit}
          />
        </section>
        {serverError && <InlineError message={serverError} />}
        <p>Run an agent in this workspace over and over until the work is done.</p>
        <div className="ui-cluster">
          <Button type="button" disabled={busy} onClick={() => void runSetupAction('cancel')}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!canStart}>
            {busy ? 'Starting…' : 'Start loop'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
