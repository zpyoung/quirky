import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { ContextMenu, IconButton, StatusDot } from '@quirky/ui'
import type { ContextMenuItem } from '@quirky/ui'
import { messageOf } from '../panel/format'
import type { GitUiControl } from '../ui-control'
import { aiControlGeneration, requestAiControl, useAiControl } from './ai-control'
import { generators, hasCustomCommand, useAgents, type AgentList } from './agents'
import { GenerateDialog } from './GenerateDialog'
import { sparkleState } from './sparkle'
import { SparkleIcon } from './SparkleIcon'
import { AI_SETTINGS_VIEW_ID, CUSTOM_AGENT } from './types'

/** Which changes a generated message describes: the index when anything is staged by hand, else everything uncommitted. */
export type SparkleScope = 'staged' | 'all'

type Props = {
  context: UiPluginContext
  worktree: string
  scope: SparkleScope
  /** How many files the message would describe. */
  files: number
  message: string
  committing: boolean
  /** Counts every change to the message box, so a result can tell whether the person edited meanwhile. */
  edits: MutableRefObject<number>
  /** Puts a generated message in the box; `agent` is the label of the agent that wrote it. */
  onResult(text: string, agent: string): void
  /** A failed generation, for the ship bar's error line. */
  onError(message: string): void
  /** A generation began, from the ✦ or from the Generate dialog. */
  onGenerateStart?(): void
}

type Run = { stopped: boolean }
type MenuSession = { generation: string; position: { x: number; y: number } }
type DialogSession = { generation: string }

function agentLabel(list: AgentList | null, id: unknown): string {
  if (typeof id !== 'string' || id === '') return 'an agent'
  if (id === CUSTOM_AGENT) return 'Custom command'
  return list?.agents.find((agent) => agent.id === id)?.label ?? id
}

/**
 * The ✦ at the right end of the message box: asks the commit message agent for a message for
 * `scope` and hands it to `onResult`, with no dialog. Its menu has "Choose agent…", which opens
 * the Generate dialog for one run. A result lands only if the box was not edited since the run
 * began (typing then deleting counts) and Stop was not pressed. Clicks are ignored while a
 * generation runs.
 */
export function CommitSparkle({ context, worktree, scope, files, message, committing, edits, onResult, onError, onGenerateStart }: Props) {
  const agents = useAgents(context, true)
  const latestList = useRef<AgentList | null>(null)
  latestList.current = agents.list
  const [generating, setGenerating] = useState(false)
  const [dialog, setDialog] = useState<DialogSession | null>(null)
  const [menu, setMenu] = useState<MenuSession | null>(null)
  const current = useRef<Run | null>(null)
  const busy = useRef(false)
  const stopReserved = useRef(false)
  const settingsOpenReserved = useRef(false)
  const alive = useRef(true)
  const pendingControls = useRef(new Set<string>())
  const menuSession = useRef<MenuSession | null>(null)
  const dialogSession = useRef<DialogSession | null>(null)
  const menuSelectionMarker = useRef<string | null>(null)
  const menuSelectionPending = useRef<string | null>(null)
  const optionsTrigger = useRef<HTMLButtonElement | null>(null)
  const sparkleGeneration = useRef<string | null>(null)
  if (sparkleGeneration.current === null) sparkleGeneration.current = aiControlGeneration()

  const sparkleTarget = `ai-sparkle:${worktree}`
  const menuTarget = `ai-sparkle-menu:${worktree}`
  const dialogTarget = `ai-generate-dialog:${worktree}`
  const agentAvailable = agents.list === null || generators(agents.list).length > 0 || hasCustomCommand(context)
  const state = sparkleState({ staged: files, message, generating, committing, agentAvailable })
  const dialogCanGenerate =
    (agents.list !== null && generators(agents.list).length > 0 || hasCustomCommand(context)) &&
    !busy.current && !stopReserved.current && !generating && !committing

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (current.current !== null) current.current.stopped = true
      current.current = null
      busy.current = false
      stopReserved.current = false
      settingsOpenReserved.current = false
      menuSession.current = null
      dialogSession.current = null
      menuSelectionMarker.current = null
      menuSelectionPending.current = null
      pendingControls.current.clear()
    }
  }, [])

  function sendAiControl(target: string, generation: string, action: string, data?: Record<string, unknown>): Promise<boolean> | null {
    const key = JSON.stringify([target, generation, action])
    if (pendingControls.current.has(key)) return null
    pendingControls.current.add(key)
    const request = requestAiControl(context, {
      target,
      generation,
      action,
      ...(data === undefined ? {} : { data })
    })
    void request.finally(() => pendingControls.current.delete(key))
    return request
  }

  function requestSparkleAction(action: string, data?: Record<string, unknown>): void {
    const generation = sparkleGeneration.current
    if (generation === null || !alive.current) return
    sendAiControl(sparkleTarget, generation, action, data)
  }

  function requestMenuAction(generation: string, action: string): Promise<boolean> | null {
    if (!alive.current || menuSession.current?.generation !== generation) return null
    return sendAiControl(menuTarget, generation, action)
  }

  function requestDialogAction(generation: string, action: string, data?: Record<string, unknown>): void {
    if (!alive.current || dialogSession.current?.generation !== generation) return
    sendAiControl(dialogTarget, generation, action, data)
  }

  function requestMenuClose(generation: string): void {
    queueMicrotask(() => {
      if (menuSelectionMarker.current === generation) {
        menuSelectionMarker.current = null
        return
      }
      if (menuSession.current?.generation !== generation) return
      requestMenuAction(generation, 'close')
    })
  }

  function requestChooseAgent(generation: string): void {
    if (!alive.current || menuSession.current?.generation !== generation) return
    if (menuSelectionPending.current === generation) {
      menuSelectionMarker.current = generation
      return
    }
    menuSelectionMarker.current = generation
    menuSelectionPending.current = generation
    queueMicrotask(() => {
      if (menuSelectionMarker.current === generation) menuSelectionMarker.current = null
    })
    const request = requestMenuAction(generation, 'choose-agent')
    if (request === null) {
      if (menuSelectionPending.current === generation) menuSelectionPending.current = null
      return
    }
    void request.finally(() => {
      if (menuSelectionPending.current === generation) menuSelectionPending.current = null
    })
  }

  function menuPosition(data: Record<string, unknown> | undefined): { x: number; y: number } | null {
    if (data === undefined || Object.keys(data).length === 0) {
      const trigger = optionsTrigger.current
      if (trigger === null) return null
      const bounds = trigger.getBoundingClientRect()
      return { x: bounds.right, y: bounds.bottom }
    }
    if (Object.keys(data).length !== 2 ||
        typeof data.x !== 'number' || !Number.isFinite(data.x) ||
        typeof data.y !== 'number' || !Number.isFinite(data.y)) return null
    return { x: data.x, y: data.y }
  }

  function hasNoData(data: Record<string, unknown> | undefined): boolean {
    return data === undefined || Object.keys(data).length === 0
  }

  function isOfferedAgent(value: unknown): value is string {
    if (typeof value !== 'string' || value.trim() === '') return false
    if (value === CUSTOM_AGENT) return hasCustomCommand(context)
    return agents.list !== null && generators(agents.list).some((agent) => agent.id === value)
  }

  async function run(params: { agent?: string; template?: string }, editsAtStart: number, mine: Run): Promise<void> {
    try {
      const result = (await context.call('quirky.git/generateCommitMessage', { worktree, scope, ...params })) as { message: string; agent?: string }
      if (alive.current && current.current === mine && !mine.stopped && edits.current === editsAtStart) {
        onResult(result.message, agentLabel(latestList.current, result.agent))
      }
    } catch (error) {
      if (alive.current && current.current === mine && !mine.stopped) onError(messageOf(error))
    } finally {
      if (current.current === mine) {
        current.current = null
        if (!stopReserved.current) {
          busy.current = false
          if (alive.current) setGenerating(false)
        }
      }
    }
  }

  function beginRun(params: { agent?: string; template?: string }): boolean {
    if (!alive.current || busy.current || stopReserved.current) return false
    busy.current = true
    const mine: Run = { stopped: false }
    current.current = mine
    setGenerating(true)
    onGenerateStart?.()
    void run(params, edits.current, mine)
    return true
  }

  function openAiSettings(): boolean {
    if (settingsOpenReserved.current) return false
    settingsOpenReserved.current = true
    void (async () => {
      try {
        await context.openView(AI_SETTINGS_VIEW_ID, { worktree })
      } catch (error) {
        if (alive.current) context.toast('Could not open AI settings', messageOf(error), { kind: 'error' })
      } finally {
        settingsOpenReserved.current = false
      }
    })()
    return true
  }

  function cancelGeneration(): void {
    void context.call('quirky.git/cancelGenerate', { worktree }).catch((error: unknown) => {
      if (alive.current) context.toast('Could not stop the generation', messageOf(error), { kind: 'error' })
    }).finally(() => {
      stopReserved.current = false
      if (current.current === null) {
        busy.current = false
        if (alive.current) setGenerating(false)
      }
    })
  }

  function handleSparkleControl(control: GitUiControl): boolean {
    if (!alive.current || control.target !== sparkleTarget || control.generation !== sparkleGeneration.current) return false
    if (control.action === 'menu-open') {
      const position = menuPosition(control.data)
      if (position === null) return false
      const session = { generation: aiControlGeneration(), position }
      menuSession.current = session
      setMenu(session)
      return true
    }
    if (!hasNoData(control.data)) return false
    if (control.action === 'generate') {
      if (state.disabled || committing || busy.current || stopReserved.current || generating) return false
      if (state.kind === 'no-agent') return openAiSettings()
      return beginRun({})
    }
    if (control.action === 'stop') {
      const activeRun = current.current
      if (!generating || activeRun === null || stopReserved.current) return false
      stopReserved.current = true
      activeRun.stopped = true
      cancelGeneration()
      return true
    }
    return false
  }

  function handleMenuControl(control: GitUiControl): boolean {
    const session = menuSession.current
    if (!alive.current || session === null || control.target !== menuTarget || control.generation !== session.generation) return false
    if (!hasNoData(control.data)) return false
    if (control.action === 'close') {
      menuSession.current = null
      setMenu(null)
      return true
    }
    if (control.action === 'choose-agent') {
      if (generating || committing || busy.current || stopReserved.current) return false
      menuSession.current = null
      setMenu(null)
      const next = { generation: aiControlGeneration() }
      dialogSession.current = next
      setDialog(next)
      return true
    }
    return false
  }

  function handleDialogControl(control: GitUiControl): boolean {
    const session = dialogSession.current
    if (!alive.current || session === null || control.target !== dialogTarget || control.generation !== session.generation) return false
    if (control.action === 'close') {
      if (!hasNoData(control.data)) return false
      dialogSession.current = null
      setDialog(null)
      return true
    }
    if (control.action !== 'generate' || control.data === undefined ||
        Object.keys(control.data).length !== 2 ||
        !Object.hasOwn(control.data, 'agent') || !Object.hasOwn(control.data, 'template') ||
        !isOfferedAgent(control.data.agent) || typeof control.data.template !== 'string' ||
        busy.current || stopReserved.current || generating || committing) return false
    dialogSession.current = null
    setDialog(null)
    return beginRun({ agent: control.data.agent, template: control.data.template })
  }

  const sparkleActions = [
    ...(!state.disabled && !busy.current && !stopReserved.current && !generating ? ['generate'] : []),
    ...(generating && current.current !== null ? ['stop'] : []),
    'menu-open'
  ]
  const sparkleAddress = {
    target: sparkleTarget,
    generation: sparkleGeneration.current!,
    actions: sparkleActions
  }
  const menuAddress = menu === null ? null : {
    target: menuTarget,
    generation: menu.generation,
    actions: ['close', ...(!generating && !committing && !busy.current && !stopReserved.current ? ['choose-agent'] : [])]
  }
  const dialogAddress = dialog === null ? null : {
    target: dialogTarget,
    generation: dialog.generation,
    actions: ['close', ...(dialogCanGenerate ? ['generate'] : [])]
  }
  useAiControl(context, sparkleAddress, handleSparkleControl)
  useAiControl(context, menuAddress, handleMenuControl)
  useAiControl(context, dialogAddress, handleDialogControl)

  const menuItems: ContextMenuItem[] = [
    {
      label: 'Choose agent…',
      enabled: !generating && !committing && !busy.current && !stopReserved.current,
      onSelect: () => {
        const session = menuSession.current
        if (session !== null) requestChooseAgent(session.generation)
      }
    }
  ]

  return (
    <span className="ui-cluster git-ship__sparkle">
      <IconButton
        label="Generate commit message with AI"
        title={state.title}
        disabled={state.disabled}
        onClick={() => requestSparkleAction('generate')}
        onContextMenu={(event) => {
          event.preventDefault()
          requestSparkleAction('menu-open', { x: event.clientX, y: event.clientY })
        }}
      >
        {generating ? <StatusDot status="working" label="Generating commit message" /> : <SparkleIcon />}
      </IconButton>
      {generating && (
        <IconButton
          label="Stop generating commit message"
          title="Generating commit message. Click to stop."
          onClick={() => requestSparkleAction('stop')}
        >
          <span aria-hidden="true">■</span>
        </IconButton>
      )}
      <IconButton
        ref={optionsTrigger}
        label="Commit message options"
        aria-haspopup="menu"
        onClick={() => requestSparkleAction('menu-open')}
      >
        <span aria-hidden="true">▾</span>
      </IconButton>
      {menu && (
        <ContextMenu
          key={menu.generation}
          x={menu.position.x}
          y={menu.position.y}
          align="end"
          label="Commit message options"
          items={menuItems}
          onClose={() => requestMenuClose(menu.generation)}
        />
      )}
      {dialog && (
        <GenerateDialog
          key={dialog.generation}
          context={context}
          agents={agents}
          onClose={() => requestDialogAction(dialog.generation, 'close')}
          onGenerate={(choice) => requestDialogAction(dialog.generation, 'generate', {
            agent: choice.agent,
            template: choice.template
          })}
        />
      )}
    </span>
  )
}
