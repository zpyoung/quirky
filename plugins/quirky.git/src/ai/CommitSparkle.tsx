import { useRef, useState, type MutableRefObject } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { ContextMenu, IconButton, StatusDot } from '@quirky/ui'
import type { ContextMenuItem } from '@quirky/ui'
import { messageOf } from '../panel/format'
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
}

type Run = { stopped: boolean }

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
export function CommitSparkle({ context, worktree, scope, files, message, committing, edits, onResult, onError }: Props) {
  const agents = useAgents(context, true)
  const latestList = useRef<AgentList | null>(null)
  latestList.current = agents.list
  const [generating, setGenerating] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const current = useRef<Run | null>(null)
  const busy = useRef(false)

  const agentAvailable = agents.list === null || generators(agents.list).length > 0 || hasCustomCommand(context)
  const state = sparkleState({ staged: files, message, generating, committing, agentAvailable })

  const run = async (params: { agent?: string; template?: string }, editsAtStart: number) => {
    const mine: Run = { stopped: false }
    current.current = mine
    setGenerating(true)
    try {
      const result = (await context.call('quirky.git/generateCommitMessage', { worktree, scope, ...params })) as { message: string; agent?: string }
      if (!mine.stopped && edits.current === editsAtStart) onResult(result.message, agentLabel(latestList.current, result.agent))
    } catch (error) {
      if (!mine.stopped) onError(messageOf(error))
    } finally {
      if (current.current === mine) {
        current.current = null
        setGenerating(false)
      }
    }
  }

  const start = async () => {
    if (state.kind === 'no-agent') return context.openView(AI_SETTINGS_VIEW_ID, { worktree })
    if (busy.current) return
    busy.current = true
    try {
      await run({}, edits.current)
    } finally {
      busy.current = false
    }
  }

  const stop = async () => {
    if (current.current) current.current.stopped = true
    try {
      await context.call('quirky.git/cancelGenerate', { worktree })
    } catch (error) {
      context.toast('Could not stop the generation', messageOf(error))
    }
  }

  const menu: ContextMenuItem[] = [
    { label: 'Choose agent…', enabled: !generating && !committing, onSelect: () => setDialog(true) }
  ]

  return (
    <span className="ui-cluster git-ship__sparkle">
      <IconButton
        label="Generate commit message with AI"
        title={state.title}
        disabled={state.disabled}
        onClick={() => void start()}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuAt({ x: event.clientX, y: event.clientY })
        }}
      >
        {generating ? <StatusDot status="working" label="Generating commit message" /> : <SparkleIcon />}
      </IconButton>
      {generating && (
        <IconButton
          label="Stop generating commit message"
          title="Generating commit message. Click to stop."
          onClick={() => void stop()}
        >
          <span aria-hidden="true">■</span>
        </IconButton>
      )}
      <IconButton
        label="Commit message options"
        aria-haspopup="menu"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          setMenuAt({ x: box.right, y: box.bottom })
        }}
      >
        <span aria-hidden="true">▾</span>
      </IconButton>
      {menuAt && <ContextMenu x={menuAt.x} y={menuAt.y} align="end" label="Commit message options" items={menu} onClose={() => setMenuAt(null)} />}
      {dialog && (
        <GenerateDialog
          context={context}
          agents={agents.list}
          onClose={() => setDialog(false)}
          onGenerate={(choice) => {
            setDialog(false)
            if (busy.current) return
            busy.current = true
            void run(choice, edits.current).finally(() => {
              busy.current = false
            })
          }}
        />
      )}
    </span>
  )
}
