import { useRef, useState, type MutableRefObject } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { messageOf } from '../panel/format'
import { generators, hasCustomCommand, useAgents } from './agents'
import { GenerateDialog } from './GenerateDialog'
import { sparkleState } from './sparkle'
import { SparkleIcon } from './SparkleIcon'
import { AI_SETTINGS_VIEW_ID, isConfigured, type Recipe } from './types'

type Props = {
  context: UiPluginContext
  worktree: string
  /** How many files are staged. */
  staged: number
  message: string
  committing: boolean
  /** Counts every change to the message box, so a result can tell whether the person edited meanwhile. */
  edits: MutableRefObject<number>
  /** Puts a generated message in the box. */
  onResult(text: string): void
}

type Run = { stopped: boolean }

/**
 * The sparkle in the commit box: asks the commit message recipe's agent for a message for what
 * is staged. Without a recipe it opens the Generate dialog for the first run. A result lands only
 * if the box was not edited since the run began (typing then deleting counts) and Stop was not pressed.
 * Clicks are ignored from the moment one starts (recipe lookup included) until its generation ends.
 */
export function CommitSparkle({ context, worktree, staged, message, committing, edits, onResult }: Props) {
  const agents = useAgents(context, true)
  const [generating, setGenerating] = useState(false)
  const [dialog, setDialog] = useState(false)
  const current = useRef<Run | null>(null)
  const busy = useRef(false)

  const agentAvailable = agents.list === null || generators(agents.list).length > 0 || hasCustomCommand(context)
  const state = sparkleState({ staged, message, generating, committing, agentAvailable })

  const run = async (params: { agent?: string; template?: string }, editsAtStart: number) => {
    const mine: Run = { stopped: false }
    current.current = mine
    setGenerating(true)
    try {
      const result = (await context.call('quirky.git/generateCommitMessage', { worktree, ...params })) as { message: string }
      if (!mine.stopped && edits.current === editsAtStart) onResult(result.message)
    } catch (error) {
      if (!mine.stopped) context.toast('Could not generate a commit message', messageOf(error))
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
      const editsAtClick = edits.current
      let configured: boolean
      try {
        configured = isConfigured((await context.call('quirky.git/aiRecipe', { worktree, action: 'commitMessage' })) as Recipe)
      } catch (error) {
        return context.toast('Could not read the commit message recipe', messageOf(error))
      }
      if (configured) await run({}, editsAtClick)
      else setDialog(true)
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

  return (
    <span className="scm-ai-spark">
      <button
        type="button"
        className="icon-button scm-ai-sparkle"
        aria-label="Generate commit message with AI"
        title={state.title}
        disabled={state.disabled}
        onClick={() => void start()}
      >
        {generating ? <span className="scm-spinner" aria-hidden="true" /> : <SparkleIcon />}
      </button>
      {generating && (
        <button
          type="button"
          className="icon-button scm-ai-stop"
          aria-label="Stop generating commit message"
          title="Generating commit message. Click to stop."
          onClick={() => void stop()}
        >
          <span className="scm-ai-stop-square" aria-hidden="true" />
        </button>
      )}
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
