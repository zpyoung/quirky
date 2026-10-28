import { useEffect, useId, useRef, useState } from 'react'
import { Badge, Button, Dialog, FormRow, SectionHeader, TextField } from '@quirky/ui'
import type { AutomationDefinition, SchedulePreset } from '../../types'
import { buildAutomationRrule, describeAutomationSchedule, isValidAutomationSchedule } from '../../schedule'
import type {
  AutomationDraft,
  AutomationEditorData,
  AutomationSurfaceProps
} from '../ui-contracts'

type EditorProps = AutomationSurfaceProps & { report?: (state: unknown) => void }
type ObjectValue = Record<string, unknown>
type AgentOption = {
  id: string
  label: string
  type: 'select' | 'boolean'
  choices: { value: string; label: string }[] | null
}
type AgentModel = { id: string; label: string; options: AgentOption[] }
type AgentOptions = { supported: boolean; structured: boolean; unlisted: 'accept' | 'refuse'; models: AgentModel[]; unlistedOptions: AgentOption[] }
type BranchRef = { name: string; kind: 'local' | 'remote' }
type TargetStatus = { available: boolean; error: string | null }
type ProjectDetails = {
  setupScript: string
  setupText: string
  setupPolicy: string | null
  defaultBase: string | null
}

const TEMPLATE_CHOICES = [
  { id: 'repo-health-weekday', label: 'Weekday repo audit' },
  { id: 'release-prep-weekly', label: 'Release readiness' },
  { id: 'recurring-review-daily', label: 'Daily change review' },
  { id: 'maintenance-hourly', label: 'Hourly maintenance check' }
] as const
const GRACE_OPTIONS = [
  { value: 0, label: 'No grace' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 180, label: '3 hours' },
  { value: 720, label: '12 hours' },
  { value: 1440, label: '24 hours' },
  { value: 2880, label: '48 hours' }
] as const
const PRECHECK_TIMEOUT_OPTIONS = [
  { value: 30, label: '30 sec' },
  { value: 60, label: '1 min' },
  { value: 120, label: '2 min' },
  { value: 300, label: '5 min' },
  { value: 600, label: '10 min' }
] as const
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAutomationDraft(value: unknown): value is AutomationDraft {
  if (!isObject(value)) return false
  if (typeof value.name !== 'string' || typeof value.prompt !== 'string' ||
    (value.agentId !== 'claude' && value.agentId !== 'codex') || typeof value.projectId !== 'string' ||
    (value.workspaceMode !== 'existing' && value.workspaceMode !== 'new_per_run') ||
    !(value.workspaceId === null || typeof value.workspaceId === 'string') ||
    !(value.baseBranch === null || typeof value.baseBranch === 'string') ||
    (value.setupDecision !== 'run' && value.setupDecision !== 'skip') || typeof value.reuseSession !== 'boolean' ||
    typeof value.timezone !== 'string' || typeof value.rrule !== 'string' ||
    typeof value.missedRunGraceMinutes !== 'number') return false
  if (value.precheck !== null && (!isObject(value.precheck) || typeof value.precheck.command !== 'string' ||
    typeof value.precheck.timeoutSeconds !== 'number')) return false
  if (value.launchOverrides !== null && !isObject(value.launchOverrides)) return false
  if (value.runContext !== null && !isObject(value.runContext)) return false
  if (value.sourceContext !== null && !isObject(value.sourceContext)) return false
  return true
}

function draftFromMethodResult(value: unknown): AutomationDraft | null {
  if (!isObject(value) || !isObject(value.editor) || !isAutomationDraft(value.editor.draft)) return null
  return value.editor.draft
}

function parseOptions(value: unknown): AgentOptions {
  if (!isObject(value) || typeof value.supported !== 'boolean' || typeof value.structured !== 'boolean' ||
    (value.unlisted !== 'accept' && value.unlisted !== 'refuse') ||
    !Array.isArray(value.models) || !Array.isArray(value.unlistedOptions)) {
    throw new Error('Agent options catalog returned an invalid response.')
  }
  const parseOption = (item: unknown): AgentOption => {
    if (!isObject(item) || typeof item.id !== 'string' || typeof item.label !== 'string' ||
      (item.type !== 'select' && item.type !== 'boolean')) throw new Error('Agent options catalog returned an invalid response.')
    let choices: AgentOption['choices'] = null
    if (item.choices !== null) {
      if (!Array.isArray(item.choices)) throw new Error('Agent options catalog returned an invalid response.')
      choices = item.choices.map((choice) => {
        if (!isObject(choice) || typeof choice.value !== 'string' || typeof choice.label !== 'string') {
          throw new Error('Agent options catalog returned an invalid response.')
        }
        return { value: choice.value, label: choice.label }
      })
    }
    return { id: item.id, label: item.label, type: item.type, choices }
  }
  const models = value.models.map((model) => {
    if (!isObject(model) || typeof model.id !== 'string' || typeof model.label !== 'string' || !Array.isArray(model.options)) {
      throw new Error('Agent options catalog returned an invalid response.')
    }
    return { id: model.id, label: model.label, options: model.options.map(parseOption) }
  })
  return {
    supported: value.supported,
    structured: value.structured,
    unlisted: value.unlisted,
    models,
    unlistedOptions: value.unlistedOptions.map(parseOption)
  }
}
function parseEditorData(value: unknown): AutomationEditorData {
  if (!isObject(value) || !Array.isArray(value.hosts) || !Array.isArray(value.projects) ||
    !Array.isArray(value.workspaces) || !Array.isArray(value.agents) || !Array.isArray(value.errors)) {
    throw new Error('Editor catalog returned an invalid response.')
  }
  const hosts = value.hosts.map((host) => {
    if (!isObject(host) || typeof host.id !== 'string' || typeof host.label !== 'string' ||
      typeof host.available !== 'boolean' || (host.reason !== undefined && typeof host.reason !== 'string')) {
      throw new Error('Editor host catalog returned an invalid response.')
    }
    return {
      id: host.id,
      label: host.label,
      available: host.available,
      ...(typeof host.reason === 'string' ? { reason: host.reason } : {})
    }
  })
  const projects = value.projects.map((project) => {
    if (!isObject(project) || typeof project.id !== 'string' || typeof project.name !== 'string' ||
      typeof project.hostId !== 'string' || typeof project.path !== 'string' || typeof project.kind !== 'string') {
      throw new Error('Editor project catalog returned an invalid response.')
    }
    return { id: project.id, name: project.name, hostId: project.hostId, path: project.path, kind: project.kind }
  })
  const workspaces = value.workspaces.map((workspace) => {
    if (!isObject(workspace) || typeof workspace.id !== 'string' || typeof workspace.repoId !== 'string' ||
      typeof workspace.name !== 'string' || typeof workspace.path !== 'string' || typeof workspace.isMain !== 'boolean') {
      throw new Error('Editor workspace catalog returned an invalid response.')
    }
    return { id: workspace.id, repoId: workspace.repoId, name: workspace.name, path: workspace.path, isMain: workspace.isMain }
  })
  const agents = value.agents.map((agent) => {
    if (!isObject(agent) || (agent.id !== 'claude' && agent.id !== 'codex') || typeof agent.label !== 'string' ||
      typeof agent.enabled !== 'boolean' || typeof agent.installed !== 'boolean' || typeof agent.isDefault !== 'boolean') {
      throw new Error('Editor agent catalog returned an invalid response.')
    }
    return { id: agent.id, label: agent.label, enabled: agent.enabled, installed: agent.installed, isDefault: agent.isDefault }
  })
  const errors = value.errors.map((error) => {
    if (typeof error !== 'string') throw new Error('Editor catalog errors returned an invalid response.')
    return error
  })
  return { hosts, projects, workspaces, agents, errors }
}


function parseProjectDetails(value: unknown): ProjectDetails {
  if (!isObject(value) || !isObject(value.settings) || !isObject(value.hooks) || !('setup' in value.hooks) ||
    !(value.settings.defaultBase === null || typeof value.settings.defaultBase === 'string')) {
    throw new Error('Project setup details returned an invalid response.')
  }
  const setupScript = typeof value.settings.setupScript === 'string' ? value.settings.setupScript : ''
  const setupPolicy = typeof value.settings.setupPolicy === 'string' ? value.settings.setupPolicy : null
  const setup = value.hooks.setup
  if (setup === null) return { setupScript, setupText: '', setupPolicy, defaultBase: value.settings.defaultBase }
  if (!isObject(setup) || typeof setup.text !== 'string') throw new Error('Project setup hooks returned an invalid response.')
  return { setupScript, setupText: setup.text, setupPolicy, defaultBase: value.settings.defaultBase }
}

function parseBranchRefs(value: unknown): BranchRef[] {
  if (!isObject(value) || !Array.isArray(value.refs)) throw new Error('Branch search returned an invalid response.')
  return value.refs.map((ref) => {
    if (!isObject(ref) || typeof ref.name !== 'string' || (ref.kind !== 'local' && ref.kind !== 'remote')) {
      throw new Error('Branch search returned an invalid response.')
    }
    return { name: ref.name, kind: ref.kind }
  })
}

function parseWorktreeTrustRows(value: unknown): ObjectValue[] {
  if (!Array.isArray(value)) throw new Error('Workspace list returned an invalid response.')
  return value.map((row) => {
    if (!isObject(row) || typeof row.id !== 'string' || typeof row.repoId !== 'string' ||
      typeof row.path !== 'string' || typeof row.name !== 'string' || typeof row.isMain !== 'boolean' ||
      typeof row.head !== 'string' || !(row.branch === null || typeof row.branch === 'string')) {
      throw new Error('Workspace list returned an invalid response.')
    }
    return row
  })
}

function presetForKind(kind: string): SchedulePreset {
  return kind === 'hourly' || kind === 'daily' || kind === 'weekdays' || kind === 'weekly' || kind === 'custom'
    ? kind
    : 'custom'
}

function parseScheduleTime(hour: string, minute: string): { hour: number; minute: number } | null {
  if (!/^\d{2}:\d{2}$/.test(hour)) return null
  const [hours, minutes] = hour.split(':').map(Number)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  const minuteValue = Number(minute)
  if (!Number.isInteger(minuteValue) || minuteValue < 0 || minuteValue > 59) return null
  return { hour: hours, minute: minutes }
}

function scheduleRule(preset: SchedulePreset, time: string, minute: string, day: number, cron: string): string {
  if (preset === 'custom') {
    try {
      return buildAutomationRrule({ preset, cron })
    } catch {
      return cron
    }
  }
  if (preset === 'hourly') {
    const minuteValue = Number(minute)
    try {
      return buildAutomationRrule({ preset, minute: minuteValue })
    } catch {
      return 'INVALID SCHEDULE'
    }
  }
  const parsed = parseScheduleTime(time, '0')
  if (!parsed) return 'INVALID SCHEDULE'
  try {
    return buildAutomationRrule({ preset, hour: parsed.hour, minute: parsed.minute, day })
  } catch {
    return 'INVALID SCHEDULE'
  }
}


function dirtyDraft(draft: AutomationDraft | null, original: AutomationDefinition | null): boolean {
  if (!draft) return false
  if (!original) return true
  const fields: (keyof AutomationDraft)[] = [
    'name', 'prompt', 'agentId', 'projectId', 'workspaceMode', 'workspaceId', 'baseBranch', 'reuseSession',
    'timezone', 'rrule', 'missedRunGraceMinutes', 'precheck', 'launchOverrides'
  ]
  if (fields.some((field) => JSON.stringify(draft[field]) !== JSON.stringify(
    field === 'precheck' || field === 'launchOverrides' ? original[field] ?? null : original[field]
  ))) return true
  return draft.setupDecision !== (original.setupDecision ?? 'skip')
}

function localDraftUpdate(current: AutomationDraft, patch: Partial<AutomationDraft>): AutomationDraft {
  const next: AutomationDraft = { ...current, ...patch }
  const projectChanged = patch.projectId !== undefined && patch.projectId !== current.projectId
  if (projectChanged) {
    next.workspaceId = null
    next.baseBranch = patch.baseBranch ?? null
    next.setupDecision = patch.setupDecision ?? 'skip'
  }
  if (patch.agentId !== undefined && patch.agentId !== current.agentId) next.launchOverrides = null
  if (patch.workspaceMode === 'new_per_run') {
    next.workspaceId = null
    next.reuseSession = false
  } else if (patch.reuseSession === true) {
    next.workspaceMode = 'existing'
    next.baseBranch = null
  }
  if (next.workspaceMode === 'existing') next.baseBranch = null
  if (next.workspaceMode === 'new_per_run') {
    next.workspaceId = null
    next.reuseSession = false
  }
  return next
}


function scheduleDisplay(draft: AutomationDraft): string {
  const description = describeAutomationSchedule(draft.rrule)
  if (isValidAutomationSchedule(draft.rrule, draft.timezone)) return description.label
  if (!draft.timezone.trim()) return 'Choose an IANA timezone.'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: draft.timezone }).format(0)
  } catch {
    return 'Choose a valid IANA timezone.'
  }
  return draft.rrule.includes('=') ? 'Pick a supported schedule before saving.' : 'Enter a valid five-field cron before saving.'
}

function scheduleValues(draft: AutomationDraft): { preset: SchedulePreset; time: string; minute: string; day: number; cron: string } {
  const description = describeAutomationSchedule(draft.rrule)
  const preset = presetForKind(description.kind)
  const hour = description.hour ?? 9
  const minute = description.minute ?? 0
  return {
    preset,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    minute: String(minute),
    day: description.day ?? 1,
    cron: draft.rrule
  }
}


export function AutomationEditor(props: EditorProps) {
  const editor = props.state.editor
  const editorKey = editor?.creationKey ?? null
  const serverDraft = editor?.draft ?? null
  const [draft, setDraft] = useState<AutomationDraft | null>(serverDraft)
  const draftRef = useRef<AutomationDraft | null>(serverDraft)
  const [data, setData] = useState<AutomationEditorData | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogErrors, setCatalogErrors] = useState<string[]>([])
  const [options, setOptions] = useState<AgentOptions | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [optionsLoading, setOptionsLoading] = useState(false)
  const [projectDetails, setProjectDetails] = useState<ProjectDetails | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [targetStatus, setTargetStatus] = useState<TargetStatus | null>(null)
  const [branchRefs, setBranchRefs] = useState<BranchRef[]>([])
  const [branchError, setBranchError] = useState<string | null>(null)
  const [branchLoading, setBranchLoading] = useState(false)
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>('weekdays')
  const [scheduleTime, setScheduleTime] = useState('09:00')
  const [hourlyMinute, setHourlyMinute] = useState('0')
  const [weeklyDay, setWeeklyDay] = useState(1)
  const [customCron, setCustomCron] = useState('0 9 * * 1-5')
  const [templateChoice, setTemplateChoice] = useState('')
  const [saving, setSaving] = useState(false)
  const [pendingWrites, setPendingWrites] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [setupWarning, setSetupWarning] = useState<string | null>(null)
  const [busyMessage, setBusyMessage] = useState<string | null>(null)
  const writeQueue = useRef<Promise<void>>(Promise.resolve())
  const writeSequence = useRef(0)
  const branchListId = useId()
  const modelListId = useId()
  const editorRootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (editorKey) editorRootRef.current?.querySelector<HTMLInputElement>('[data-auto-editor-autofocus]')?.focus()
  }, [editorKey])

  function syncSchedule(value: AutomationDraft): void {
    const fields = scheduleValues(value)
    setSchedulePreset(fields.preset)
    setScheduleTime(fields.time)
    setHourlyMinute(fields.minute)
    setWeeklyDay(fields.day)
    setCustomCron(fields.cron)
  }

  useEffect(() => {
    draftRef.current = serverDraft
    setDraft(serverDraft)
    setSaveError(null)
    setSetupWarning(null)
    setTemplateChoice('')
    if (serverDraft) syncSchedule(serverDraft)
  }, [editorKey])

  useEffect(() => {
    if (!editorKey) {
      setData(null)
      setCatalogErrors([])
      setCatalogLoading(false)
      return
    }
    let current = true
    setCatalogLoading(true)
    void props.context.call('quirky.automations/editorData', {}).then((value) => {
      if (!current) return
      const result = parseEditorData(value)
      setData(result)
      setCatalogErrors(result.errors)
    }).catch((error: unknown) => {
      if (current) {
        setData(null)
        setCatalogErrors([`Editor data could not be loaded: ${errorMessage(error)}`])
      }
    }).finally(() => {
      if (current) setCatalogLoading(false)
    })
    return () => { current = false }
  }, [editorKey, props.context])

  useEffect(() => {
    if (!editor?.id) {
      setTargetStatus(null)
      return
    }
    let current = true
    setTargetStatus(null)
    void props.context.call('quirky.automations/target', { id: editor.id }).then((value) => {
      if (!current) return
      if (!isObject(value) || typeof value.available !== 'boolean') throw new Error('Automation target returned an invalid response.')
      if (!value.available) {
        if (typeof value.status !== 'string' || typeof value.error !== 'string') {
          throw new Error('Automation target returned an invalid response.')
        }
        setTargetStatus({ available: false, error: value.error })
        return
      }
      const target = value.target
      if (!isObject(target) || typeof target.repoId !== 'string' || typeof target.repoPath !== 'string' ||
        typeof target.cwd !== 'string' || !(target.workspaceId === null || typeof target.workspaceId === 'string') ||
        !(target.workspaceDisplayName === null || typeof target.workspaceDisplayName === 'string') ||
        !isObject(target.owner) || target.owner.kind !== 'local' || typeof target.owner.repoId !== 'string' ||
        typeof target.owner.repoPath !== 'string' ||
        !(target.owner.workspaceId === null || typeof target.owner.workspaceId === 'string') ||
        !(target.owner.workspacePath === null || typeof target.owner.workspacePath === 'string') ||
        !(target.owner.workspaceInstanceId === null || typeof target.owner.workspaceInstanceId === 'string')) {
        throw new Error('Automation target returned an invalid local-authority response.')
      }
      setTargetStatus({ available: true, error: null })
    }).catch((error: unknown) => {
      if (current) setTargetStatus({ available: false, error: `Target availability could not be checked: ${errorMessage(error)}` })
    })
    return () => { current = false }
  }, [editor?.id, props.context])

  useEffect(() => {
    if (!draft?.agentId) {
      setOptions(null)
      setOptionsError(null)
      return
    }
    let current = true
    setOptions(null)
    setOptionsLoading(true)
    setOptionsError(null)
    void props.context.call('quirky.agents/options', { agent: draft.agentId, host: 'local' }).then((value) => {
      if (!current) return
      setOptions(parseOptions(value))
    }).catch((error: unknown) => {
      if (current) {
        setOptions(null)
        setOptionsError(`Agent options could not be loaded: ${errorMessage(error)}`)
      }
    }).finally(() => {
      if (current) setOptionsLoading(false)
    })
    return () => { current = false }
  }, [draft?.agentId, editorKey, props.context])

  useEffect(() => {
    if (!draft?.projectId) {
      setProjectDetails(null)
      setProjectError(null)
      return
    }
    let current = true
    setProjectDetails(null)
    setProjectError(null)
    void props.context.call('quirky.repo/show', { repo: draft.projectId }).then((value) => {
      if (current) setProjectDetails(parseProjectDetails(value))
    }).catch((error: unknown) => {
      if (current) setProjectError(`Project setup could not be checked: ${errorMessage(error)}`)
    })
    return () => { current = false }
  }, [draft?.projectId, editorKey, props.context])

  useEffect(() => {
    if (!draft || draft.workspaceMode !== 'new_per_run' || !draft.projectId || !data) {
      setBranchRefs([])
      setBranchError(null)
      setBranchLoading(false)
      return
    }
    const project = data.projects.find((entry) => entry.id === draft.projectId)
    const main = data.workspaces.find((entry) => entry.repoId === draft.projectId && entry.isMain)
    if (!project || project.kind !== 'git' || !main) {
      setBranchRefs([])
      setBranchError(project?.kind === 'folder' ? 'Branches are only available for Git projects.' : null)
      setBranchLoading(false)
      return
    }
    let current = true
    const timer = setTimeout(() => {
      setBranchLoading(true)
      setBranchError(null)
      void props.context.call('quirky.git/branches', {
        worktree: main.id,
        ...(draft.baseBranch ? { query: draft.baseBranch } : {})
      }).then((value) => {
        if (current) setBranchRefs(parseBranchRefs(value))
      }).catch((error: unknown) => {
        if (current) {
          setBranchRefs([])
          setBranchError(`Branches could not be loaded: ${errorMessage(error)}`)
        }
      }).finally(() => {
        if (current) setBranchLoading(false)
      })
    }, 160)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [draft?.projectId, draft?.workspaceMode, draft?.baseBranch, data, editorKey, props.context])

  const dirty = dirtyDraft(draft, editor?.original ?? null)
  const visibleErrors = [ ...(catalogErrors ?? []), optionsError, projectError, branchError, saveError ]
    .filter((message): message is string => Boolean(message))
  const scheduleValid = draft ? isValidAutomationSchedule(draft.rrule, draft.timezone) : false
  const availableProjects = data?.projects ?? []
  const hasProjects = availableProjects.length > 0
  const canSave = Boolean(draft && hasProjects && !saving && pendingWrites === 0 && (!editor?.original || dirty))
  const selectedAgent = data?.agents.find((agent) => agent.id === draft?.agentId)
  const agentUnavailable = Boolean(data && draft && (!selectedAgent?.enabled || !selectedAgent.installed))
  const selectedModelId = draft?.launchOverrides?.model
  const selectedModel = options?.models.find((model) => model.id === selectedModelId)
  const displaySavedModel = Boolean(selectedModelId && !selectedModel)
  const savedModelUnavailable = Boolean(displaySavedModel && options?.unlisted === 'refuse' && !optionsLoading)
  const modelOptions = selectedModel?.options ?? (
    !selectedModelId || options?.unlisted === 'accept' ? options?.unlistedOptions ?? [] : []
  )
  const currentOptionValues = draft?.launchOverrides?.optionValues ?? {}
  const unavailableOptionIds = options && !optionsLoading
    ? Object.keys(currentOptionValues).filter((id) => !modelOptions.some((option) => option.id === id))
    : []
  const setupPresent = Boolean(projectDetails?.setupText.trim() || projectDetails?.setupScript.trim())
  const setupEnabled = Boolean(draft?.workspaceMode === 'new_per_run' && draft.setupDecision === 'run')
  const reportError = [...visibleErrors, ...(targetStatus?.error ? [targetStatus.error] : []),
    ...(setupWarning ? [setupWarning] : [])].join(' · ')

  useEffect(() => {
    props.report?.({
      kind: 'editor',
      busy: saving || pendingWrites > 0,
      error: reportError || null,
      dirty,
      canSave,
      project: { available: hasProjects, id: draft?.projectId ?? null },
      host: { id: 'local', available: targetStatus?.available ?? true, error: targetStatus?.error ?? null },
      catalog: { loading: catalogLoading, available: Boolean(data), errors: catalogErrors },
      schedule: { valid: scheduleValid, label: draft ? scheduleDisplay(draft) : '' },
      setup: { enabled: setupEnabled, available: setupPresent, policy: projectDetails?.setupPolicy ?? null, warning: setupWarning }
    })
  }, [props.report, saving, pendingWrites, reportError, dirty, canSave, hasProjects, draft?.projectId,
    targetStatus, catalogLoading, data, catalogErrors, scheduleValid, draft?.rrule, draft?.timezone,
    setupEnabled, setupPresent, setupWarning])

  function updateDraft(patch: Partial<AutomationDraft>, template?: string): void {
    const current = draftRef.current
    if (!current) return
    const updated = localDraftUpdate(current, patch)
    if (patch.agentId !== undefined && patch.agentId !== current.agentId) {
      setOptions(null)
      setOptionsError(null)
    }
    if (patch.projectId !== undefined && patch.projectId !== current.projectId) {
      setProjectDetails(null)
      setProjectError(null)
    }
    draftRef.current = updated
    setDraft(updated)
    setSaveError(null)
    setPendingWrites((count) => count + 1)
    const sequence = ++writeSequence.current
    const params = { patch, ...(template === undefined ? {} : { template }) }
    const nextWrite = writeQueue.current.then(async () => {
      const result = await props.context.call('quirky.automations/patchDraft', params)
      const returned = draftFromMethodResult(result)
      if (sequence === writeSequence.current && returned) {
        draftRef.current = returned
        setDraft(returned)
        if (template !== undefined) syncSchedule(returned)
      }
      await props.refresh()
    }).catch((error: unknown) => {
      if (sequence === writeSequence.current) {
        const message = `Draft could not be updated: ${errorMessage(error)}`
        setSaveError(message)
        props.notify(message, 'error')
      }
    }).finally(() => {
      setPendingWrites((count) => Math.max(0, count - 1))
    })
    writeQueue.current = nextWrite
  }

  function updateOverrides(next: AutomationDraft['launchOverrides']): void {
    updateDraft({ launchOverrides: next })
  }

  function updateOptionValue(optionId: string, value: string | boolean | null): void {
    const current = draftRef.current
    if (!current) return
    const optionValues = { ...(current.launchOverrides?.optionValues ?? {}) }
    if (value === null) delete optionValues[optionId]
    else optionValues[optionId] = value
    const overrides = {
      ...(current.launchOverrides?.model === undefined ? {} : { model: current.launchOverrides.model }),
      ...(Object.keys(optionValues).length === 0 ? {} : { optionValues })
    }
    updateOverrides(Object.keys(overrides).length === 0 ? null : overrides)
  }

  function changeSchedule(preset: SchedulePreset, time: string, minute: string, day: number, cron: string): void {
    updateDraft({ rrule: scheduleRule(preset, time, minute, day, cron) })
  }

  function setTime(value: string): void {
    setScheduleTime(value)
    changeSchedule(schedulePreset, value, hourlyMinute, weeklyDay, customCron)
  }

  function setMinute(value: string): void {
    setHourlyMinute(value)
    changeSchedule(schedulePreset, scheduleTime, value, weeklyDay, customCron)
  }

  function setDay(value: number): void {
    setWeeklyDay(value)
    changeSchedule(schedulePreset, scheduleTime, hourlyMinute, value, customCron)
  }

  function changePreset(value: SchedulePreset): void {
    const current = draftRef.current
    if (!current) return
    let cron = customCron
    if (value === 'custom' && describeAutomationSchedule(current.rrule).kind !== 'custom') {
      cron = '0 9 * * 1-5'
      setCustomCron(cron)
    }
    setSchedulePreset(value)
    changeSchedule(value, scheduleTime, hourlyMinute, weeklyDay, cron)
  }

  async function setupConsent(): Promise<boolean | undefined> {
    const current = draftRef.current
    if (!current || current.workspaceMode !== 'new_per_run' || current.setupDecision !== 'run') return undefined
    try {
      const workspaces = parseWorktreeTrustRows(await props.context.call('quirky.worktree/list', { repo: current.projectId }))
      const branch = current.baseBranch ?? projectDetails?.defaultBase ?? null
      const base = branch
        ? workspaces.find((workspace) => workspace.repoId === current.projectId && workspace.branch === branch)
        : workspaces.find((workspace) => workspace.repoId === current.projectId && workspace.isMain)
      const ref = base && typeof base.head === 'string' && base.head ? base.head : null
      if (!ref) {
        setSetupWarning('No immutable workspace revision is available to inspect; setup will be skipped.')
        return false
      }
      const hooks = await props.context.call('quirky.repo/hooks', { repo: current.projectId, ref })
      if (!isObject(hooks) || !('setup' in hooks) || !isObject(hooks.setup) || typeof hooks.setup.text !== 'string' ||
        !('shared' in hooks.setup)) {
        setSetupWarning('Setup hooks could not be inspected; setup will be skipped.')
        return false
      }
      const setup = hooks.setup
      if (typeof setup.text !== 'string' || !setup.text.trim()) {
        setSetupWarning('No setup hook is available at the selected revision; setup will be skipped.')
        return false
      }
      if (setup.shared === null) return undefined
      if (!isObject(setup.shared) || typeof setup.shared.text !== 'string' || typeof setup.shared.trusted !== 'boolean' ||
        typeof setup.shared.changed !== 'boolean') {
        setSetupWarning('Setup trust could not be inspected; setup will be skipped.')
        return false
      }
      if (setup.shared.trusted && !setup.shared.changed) return undefined
      const confirmed = await props.context.confirm({
        title: 'Trust project setup hook?',
        body: `Allow this shared setup hook for future automation runs at ${ref}?\n\n${setup.shared.text}`,
        confirmLabel: 'Trust and save'
      })
      if (!confirmed) {
        setSetupWarning('Setup trust was declined; setup will be skipped.')
        return false
      }
      await props.context.call('quirky.repo/trustHooks', { repo: current.projectId, kind: 'setup', ref })
      return true
    } catch (error) {
      setSetupWarning(`Setup trust could not be checked; setup will be skipped: ${errorMessage(error)}`)
      return false
    }
  }

  async function save(): Promise<void> {
    if (!draftRef.current || !canSave) return
    setSaving(true)
    setBusyMessage('Saving automation…')
    setSaveError(null)
    setSetupWarning(null)
    try {
      await writeQueue.current
      const trustSetup = await setupConsent()
      const params = trustSetup === undefined ? {} : { trustSetup }
      const saved = await props.context.call('quirky.automations/saveEditor', params)
      await props.refresh()
      const requestedSetup = draftRef.current?.workspaceMode === 'new_per_run' && draftRef.current.setupDecision === 'run'
      if (requestedSetup && isObject(saved) && saved.setupDecision !== 'run') {
        const warning = setupWarning ?? 'Setup could not be verified or trusted, so this automation will skip setup.'
        setSetupWarning(warning)
        props.notify(warning, 'info')
      } else {
        props.notify(editor?.id ? 'Automation updated.' : 'Automation saved.', 'success')
      }
    } catch (error) {
      const message = errorMessage(error)
      setSaveError(message)
      props.notify(message, 'error')
    } finally {
      setSaving(false)
      setBusyMessage(null)
    }
  }

  async function cancel(): Promise<void> {
    setSaving(true)
    try {
      await writeQueue.current
      await props.context.call('quirky.automations/cancelEditor', {})
      await props.refresh()
    } catch (error) {
      const message = errorMessage(error)
      setSaveError(message)
      props.notify(message, 'error')
    } finally {
      setSaving(false)
    }
  }

  if (!editor || !draft) return null

  const currentOverrides = draft.launchOverrides
  const availableWorkspaces = (data?.workspaces ?? []).filter((workspace) => workspace.repoId === draft.projectId)
  const activeWorkspaceMissing = Boolean(draft.workspaceMode === 'existing' && draft.workspaceId &&
    !availableWorkspaces.some((workspace) => workspace.id === draft.workspaceId))
  const customFields = draft.rrule.trim().split(/\s+/)
  const scheduleStatus = scheduleDisplay(draft)
  const rawArgsExplanation = 'Raw extra agent arguments are unsupported for structured sessions. Use the model and options catalog above.'

  return (
    <div className="auto-editor-scope" onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }}>
      <Dialog
        open
        title={editor.id ? 'Edit automation' : 'Create automation'}
        closeOnBackdrop={false}
        onClose={() => { if (!saving) void cancel() }}
        actions={<>
          <span className="auto-editor__form-status">{busyMessage ?? (editor.id ? 'Save Changes is available when a field changes.' : 'New automations are enabled when saved.')}</span>
          <Button disabled={saving} onClick={() => void cancel()}>Cancel</Button>
          <Button variant="primary" type="submit" form="auto-editor-form" disabled={!canSave}>{saving ? 'Saving…' : editor.id ? 'Save Changes' : 'Create'}</Button>
        </>}
      >
        <div
          className="auto-editor"
          ref={editorRootRef}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            if (!saving) void cancel()
          }}
        >
          <div className="auto-editor__intro">
            <p>Once saved, runs automatically until paused.</p>
            {!editor.id && <FormRow label="Use template" htmlFor="auto-editor-template">
              <select id="auto-editor-template" value={templateChoice} onChange={(event) => {
                const id = event.currentTarget.value
                setTemplateChoice(id)
                if (id) updateDraft({}, id)
              }}>
                <option value="">Choose a template…</option>
                {TEMPLATE_CHOICES.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}
              </select>
            </FormRow>}
          </div>

          <form id="auto-editor-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
            <div className="auto-editor__layout">
              <section className="auto-editor__prompt" aria-label="Automation prompt and name">
                <TextField
                  id="auto-editor-name"
                  label="Automation name"
                  data-auto-editor-autofocus
                  className="auto-editor__name"
                  value={draft.name}
                  placeholder="Weekday repo audit"
                  maxLength={256}
                  onChange={(event) => updateDraft({ name: event.currentTarget.value })}
                />
                <FormRow label="Prompt" htmlFor="auto-editor-prompt" help="Supports skills, file paths, and built-in commands like /goal.">
                  <textarea
                    id="auto-editor-prompt"
                    value={draft.prompt}
                    placeholder="Run the weekly dependency audit and summarize risky changes."
                    maxLength={64 * 1024}
                    aria-invalid={!draft.prompt.trim()}
                    onChange={(event) => updateDraft({ prompt: event.currentTarget.value })}
                  />
                </FormRow>
                {targetStatus && !targetStatus.available && <div className="auto-editor__warning" role="status">Saved target unavailable: {targetStatus.error}</div>}
                {catalogLoading && <div className="auto-editor__muted" role="status">Loading projects, workspaces, and agents…</div>}
                {!hasProjects && !catalogLoading && <div className="auto-editor__warning" role="status">No projects are available on Local. Add a project before saving an automation.</div>}
                {visibleErrors.map((message) => <div key={message} className="auto-editor__error" role="alert">{message}</div>)}
                {setupWarning && <div className="auto-editor__warning" role="status">{setupWarning}</div>}
              </section>

              <aside className="auto-editor__settings" aria-label="Automation settings">
                <FormRow label="Agent" htmlFor="auto-editor-agent" help={agentUnavailable ? 'This saved or selected agent is unavailable. Choose an enabled structured agent to continue.' : undefined}>
                  <select id="auto-editor-agent" value={draft.agentId} onChange={(event) => {
                    const agentId = event.currentTarget.value
                    if (agentId === 'claude' || agentId === 'codex') updateDraft({ agentId })
                  }}>
                    {agentUnavailable && <option value={draft.agentId} disabled>{draft.agentId} ({editor.original ? 'saved agent unavailable' : 'agent unavailable'})</option>}
                    {(data?.agents ?? []).map((agent) => (
                      <option key={agent.id} value={agent.id} disabled={!agent.enabled || !agent.installed}>
                        {agent.label}{!agent.installed ? ' (not installed)' : !agent.enabled ? ' (disabled)' : ''}
                      </option>
                    ))}
                  </select>
                </FormRow>

                <div className="auto-editor__field">
                  <TextField
                    id="auto-editor-model"
                    label="Model"
                    list={modelListId}
                    value={currentOverrides?.model ?? ''}
                    disabled={optionsLoading}
                    maxLength={128}
                    placeholder="Default (from Settings)"
                    onChange={(event) => {
                      const model = event.currentTarget.value
                      updateOverrides(model ? { model, optionValues: {} } : null)
                    }}
                  />
                  {currentOverrides?.model && <Button onClick={() => updateOverrides(null)}>Use default</Button>}
                  <datalist id={modelListId}>
                    {(options?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                  </datalist>
                  {optionsError && <span className="auto-editor__error" role="alert">{optionsError}</span>}
                  {options?.unlisted === 'accept' && <span className="auto-editor__help">This agent accepts opaque custom model IDs; native launch validation checks them when saved.</span>}
                  {options?.unlisted === 'refuse' && <span className="auto-editor__help">This agent's native catalog may refuse model IDs that are not listed.</span>}
                  {!options?.supported && options && <span className="auto-editor__help">This agent does not publish structured launch options.</span>}
                  {!options?.structured && options && <span className="auto-editor__help">This agent cannot use structured automation sessions.</span>}
                  {savedModelUnavailable && <span className="auto-editor__warning" role="status">Saved model “{currentOverrides?.model}” is not in this agent's catalog and may be refused. Choose a listed model or clear it.</span>}
                </div>

                {modelOptions.map((option) => {
                  const value = currentOptionValues[option.id]
                  const invalidSavedValue = value !== undefined && (
                    option.type === 'boolean'
                      ? typeof value !== 'boolean'
                      : typeof value !== 'string' || !option.choices?.some((choice) => choice.value === value)
                  )
                  return (
                    <div className="auto-editor__field" key={option.id}>
                      {option.type === 'boolean' ? (
                        <>
                          <span className="auto-editor__field-label">{option.label}</span>
                          {invalidSavedValue && <span className="auto-editor__warning" role="status">Saved value is not in the current option catalog.</span>}
                          <label className="auto-editor__check-row"><input id={`auto-option-${option.id}`} type="checkbox" checked={value === true} onChange={(event) => updateOptionValue(option.id, event.currentTarget.checked)} /> Enabled</label>
                          {value !== undefined && <Button onClick={() => updateOptionValue(option.id, null)}>Use default</Button>}
                        </>
                      ) : (
                        <>
                          {invalidSavedValue && <span className="auto-editor__warning" role="status">Saved value is not in the current option catalog.</span>}
                          <div className="auto-editor__control-row">
                            <FormRow label={option.label} htmlFor={`auto-option-${option.id}`}>
                              <select
                                id={`auto-option-${option.id}`}
                                value={typeof value === 'string' ? value : ''}
                                onChange={(event) => updateOptionValue(option.id, event.currentTarget.value || null)}
                              >
                                <option value="">Default</option>
                                {typeof value === 'string' && !option.choices?.some((choice) => choice.value === value) &&
                                  <option value={value}>{value} (unavailable)</option>}
                                {(option.choices ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                              </select>
                            </FormRow>
                            {value !== undefined && <Button onClick={() => updateOptionValue(option.id, null)}>Use default</Button>}
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
                {unavailableOptionIds.map((id) => (
                  <div className="auto-editor__warning" role="status" key={`unavailable-${id}`}>
                    Saved option “{id}” is unavailable for this model.
                    <Button onClick={() => updateOptionValue(id, null)}>Clear saved option</Button>
                  </div>
                ))}

                <FormRow label="Extra agent arguments" htmlFor="auto-editor-extra-args" help={rawArgsExplanation}>
                  <textarea id="auto-editor-extra-args" disabled value="" placeholder="Raw arguments are unavailable" />
                </FormRow>

                <section className="auto-editor__section" aria-label="Run target">
                  <SectionHeader title="Run target" />
                  <FormRow label="Host" htmlFor="auto-editor-host" help="Stored and scheduled by this local Quirky daemon. Remote authority is unavailable.">
                    <select id="auto-editor-host" value="local" disabled>
                      <option value="local">Local</option>
                    </select>
                  </FormRow>
                  <FormRow label="Project" htmlFor="auto-editor-project">
                    <select
                      id="auto-editor-project"
                      value={draft.projectId}
                      onChange={(event) => {
                        setBranchRefs([])
                        updateDraft({ projectId: event.currentTarget.value })
                      }}
                    >
                      {!availableProjects.some((project) => project.id === draft.projectId) && draft.projectId &&
                        <option value={draft.projectId} disabled>Unavailable project: {draft.projectId}</option>}
                      <option value="">Select project</option>
                      {availableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                  </FormRow>
                  <div className="auto-editor__field">
                    <span className="auto-editor__field-label">Workspace</span>
                    <div className="auto-editor__toggle" role="group" aria-label="Workspace mode">
                      <Button className="auto-editor__toggle-option" aria-pressed={draft.workspaceMode === 'existing'} onClick={() => updateDraft({ workspaceMode: 'existing' })}>Worktree</Button>
                      <Button className="auto-editor__toggle-option" aria-pressed={draft.workspaceMode === 'new_per_run'} onClick={() => updateDraft({ workspaceMode: 'new_per_run' })}>New run</Button>
                    </div>
                  </div>
                  {draft.workspaceMode === 'existing' ? (
                    <FormRow label="Workspace" htmlFor="auto-editor-workspace" error={activeWorkspaceMissing ? 'Choose an available workspace before saving.' : undefined}>
                      <select id="auto-editor-workspace" value={draft.workspaceId ?? ''} onChange={(event) => updateDraft({ workspaceId: event.currentTarget.value || null })}>
                        {activeWorkspaceMissing && <option value={draft.workspaceId ?? ''} disabled>Unavailable workspace: {draft.workspaceId}</option>}
                        <option value="">Select workspace</option>
                        {availableWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}{workspace.isMain ? ' (main)' : ''}</option>)}
                      </select>
                    </FormRow>
                  ) : (
                    <div className="auto-editor__field">
                      <FormRow label="Create from" htmlFor="auto-editor-base-branch" help="Leave blank to use the project default branch.">
                        <input
                          id="auto-editor-base-branch"
                          list={branchListId}
                          value={draft.baseBranch ?? ''}
                          placeholder="Project default"
                          onChange={(event) => updateDraft({ baseBranch: event.currentTarget.value || null })}
                        />
                      </FormRow>
                      <datalist id={branchListId}>
                        {branchRefs.map((branch) => <option key={`${branch.kind}:${branch.name}`} value={branch.name}>{branch.kind}</option>)}
                      </datalist>
                      {branchLoading && <span className="auto-editor__muted" role="status">Searching branches…</span>}
                      {branchError && <span className="auto-editor__error" role="alert">{branchError}</span>}
                    </div>
                  )}
                  <div className="auto-editor__field">
                    <span className="auto-editor__field-label">Session</span>
                    <div className="auto-editor__toggle" role="group" aria-label="Session mode">
                      <Button className="auto-editor__toggle-option" aria-pressed={!draft.reuseSession} onClick={() => updateDraft({ reuseSession: false })}>Fresh</Button>
                      <Button className="auto-editor__toggle-option" aria-pressed={draft.reuseSession} onClick={() => updateDraft({ reuseSession: true })}>Reuse</Button>
                    </div>
                    <span className="auto-editor__help">Reuse sends future runs to the previous live automation session. New run always starts fresh.</span>
                  </div>
                </section>

                <section className="auto-editor__section" aria-label="Schedule and run policy">
                  <SectionHeader title="Schedule and run policy" />
                  <FormRow label="Cadence" htmlFor="auto-editor-cadence">
                    <select id="auto-editor-cadence" value={schedulePreset} onChange={(event) => changePreset(event.currentTarget.value as SchedulePreset)}>
                      <option value="hourly">Hourly</option>
                      <option value="daily">Daily</option>
                      <option value="weekdays">Weekdays</option>
                      <option value="weekly">Weekly</option>
                      <option value="custom">Custom cron</option>
                    </select>
                  </FormRow>
                  {schedulePreset === 'hourly' ? (
                    <FormRow label="Minute" htmlFor="auto-editor-minute">
                      <select id="auto-editor-minute" value={hourlyMinute} onChange={(event) => setMinute(event.currentTarget.value)}>
                        {Array.from({ length: 60 }, (_, minute) => <option key={minute} value={minute}>{minute.toString().padStart(2, '0')}</option>)}
                      </select>
                    </FormRow>
                  ) : schedulePreset === 'weekly' ? (
                    <>
                      <FormRow label="Day" htmlFor="auto-editor-day">
                        <select id="auto-editor-day" value={weeklyDay} onChange={(event) => setDay(Number(event.currentTarget.value))}>
                          {WEEKDAYS.map((day, value) => <option key={value} value={value}>{day}</option>)}
                        </select>
                      </FormRow>
                      <FormRow label="Time" htmlFor="auto-editor-time">
                        <input id="auto-editor-time" type="time" value={scheduleTime} onChange={(event) => setTime(event.currentTarget.value)} />
                      </FormRow>
                    </>
                  ) : schedulePreset === 'daily' || schedulePreset === 'weekdays' ? (
                    <FormRow label="Time" htmlFor="auto-editor-time">
                      <input id="auto-editor-time" type="time" value={scheduleTime} onChange={(event) => setTime(event.currentTarget.value)} />
                    </FormRow>
                  ) : (
                    <div className="auto-editor__field">
                      <FormRow label="Cron expression" htmlFor="auto-editor-cron">
                        <input id="auto-editor-cron" value={customCron} maxLength={2048} placeholder="0 9 * * 1-5" onChange={(event) => {
                          const value = event.currentTarget.value
                          setCustomCron(value)
                          changeSchedule('custom', scheduleTime, hourlyMinute, weeklyDay, value)
                        }} />
                      </FormRow>
                      <div className="auto-editor__chips" aria-label="Cron fields">
                        {['Minute', 'Hour', 'Day', 'Month', 'Weekday'].map((label, index) => (
                          <div className="auto-editor__chip" key={label}><span>{label}</span><code>{customFields[index] ?? '—'}</code></div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="auto-editor__schedule-status" role="status">
                    <Badge tone={scheduleValid ? 'working' : 'failing'}>{scheduleStatus}</Badge>
                  </div>
                  <FormRow label="Timezone" htmlFor="auto-editor-timezone" help={`Uses an IANA timezone such as ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}.`}>
                    <input id="auto-editor-timezone" value={draft.timezone} onChange={(event) => updateDraft({ timezone: event.currentTarget.value })} />
                  </FormRow>
                  <FormRow label="Grace" htmlFor="auto-editor-grace">
                    <select id="auto-editor-grace" value={draft.missedRunGraceMinutes} onChange={(event) => updateDraft({ missedRunGraceMinutes: Number(event.currentTarget.value) })}>
                      {GRACE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </FormRow>
                </section>

                <section className="auto-editor__section" aria-label="Precheck">
                  <SectionHeader title="Precheck" />
                  <FormRow label="Run precheck" htmlFor="auto-editor-precheck">
                    <input id="auto-editor-precheck" type="checkbox" checked={draft.precheck !== null} onChange={(event) => updateDraft({
                      precheck: event.currentTarget.checked ? { command: '', timeoutSeconds: 60 } : null
                    })} />
                  </FormRow>
                  {draft.precheck && (
                    <>
                      <FormRow label="Timeout" htmlFor="auto-editor-precheck-timeout">
                        <select id="auto-editor-precheck-timeout" value={draft.precheck.timeoutSeconds} onChange={(event) => updateDraft({
                          precheck: { ...draft.precheck!, timeoutSeconds: Number(event.currentTarget.value) }
                        })}>
                          {PRECHECK_TIMEOUT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </FormRow>
                      <FormRow label="Command" htmlFor="auto-editor-precheck-command">
                        <textarea id="auto-editor-precheck-command" value={draft.precheck.command} placeholder="gh pr list --json number -q '.[0].number'"
                          onChange={(event) => updateDraft({ precheck: { ...draft.precheck!, command: event.currentTarget.value } })} />
                      </FormRow>
                    </>
                  )}
                </section>

                {draft.workspaceMode === 'new_per_run' && (setupPresent || projectError) && (
                  <section className="auto-editor__section" aria-label="Workspace setup">
                    <SectionHeader title="Workspace setup" />
                    <FormRow label="Run setup for each new workspace" htmlFor="auto-editor-setup" help="Setup defaults to skipped. Shared setup hooks require explicit trust before they can run unattended.">
                      <input id="auto-editor-setup" type="checkbox" checked={draft.setupDecision === 'run'} onChange={(event) => updateDraft({ setupDecision: event.currentTarget.checked ? 'run' : 'skip' })} />
                    </FormRow>
                    {projectDetails?.setupPolicy && <span className="auto-editor__help">Project setup policy: {projectDetails.setupPolicy}</span>}
                    {projectError && <span className="auto-editor__error" role="alert">{projectError}</span>}
                  </section>
                )}
              </aside>
            </div>
          </form>
        </div>
      </Dialog>
    </div>
  )
}
