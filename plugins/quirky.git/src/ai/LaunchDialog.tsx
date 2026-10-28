import { useEffect, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Dialog } from '../panel/Dialog'
import { messageOf } from '../panel/format'
import { initialAgent, isUsable, useAgents } from './agents'
import { DEFAULT_TEMPLATE, type FixAction, type LaunchParams, type Recipe } from './types'
import type { RecipeLaunchOptions } from '../daemon/recipe-options'
import { LaunchOptionsEditor } from './LaunchOptionsEditor'

const TITLES: Readonly<Record<FixAction, string>> = {
  fixCommitFailure: 'Fix Commit Failure With AI',
  fixPushFailure: 'Fix Push Failure With AI',
  resolveConflicts: 'Resolve Conflicts With AI'
}

type Preview = { prompt: string; recipe: Recipe }

type Props = {
  context: UiPluginContext
  worktree: string
  action: FixAction
  onClose(): void
  /** Starts the agent; resolves with whether it started, so a refusal keeps the dialog open. */
  start(launch: LaunchParams): Promise<boolean>
}

/**
 * The template a prompt text stands for: the recipe's own template when the text is the prompt it
 * rendered, that template plus what was appended when the text only extends it, else the text
 * itself. Saving the rendered prompt as a template would freeze one failure's text into the recipe.
 */
function templateOf(text: string, prompt: string, template: string): string {
  if (text === prompt) return template
  if (prompt !== '' && text.startsWith(prompt)) return template + text.slice(prompt.length)
  return text
}
function sameLaunchOptions(left: RecipeLaunchOptions | null, right: RecipeLaunchOptions | null): boolean {
  if (left === null || right === null) return left === right
  const leftValues = left?.optionValues ?? {}
  const rightValues = right?.optionValues ?? {}
  const leftKeys = Object.keys(leftValues).sort()
  const rightKeys = Object.keys(rightValues).sort()
  return left?.model === right?.model && leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && leftValues[key] === rightValues[key])
}

function hasLaunchChoices(value: RecipeLaunchOptions | null): boolean {
  return value !== null && value !== undefined && (value.model !== undefined || Object.keys(value.optionValues ?? {}).length > 0)
}

type FormProps = Props & { preview: Preview; agents: ReturnType<typeof useAgents> }

function LaunchForm({ context, action, preview, agents, onClose, start }: FormProps) {
  const { recipe } = preview
  const usable = agents.list === null ? [] : agents.list.agents.filter(isUsable)
  const fallback = agents.list === null ? '' : initialAgent(agents.list, usable)
  const initial = recipe.agent ?? fallback
  const [picked, setPicked] = useState<string | null>(null)
  const agent = picked ?? initial
  const [launchChoices, setLaunchChoices] = useState<Map<string, RecipeLaunchOptions | null>>(
    () => new Map<string, RecipeLaunchOptions | null>([[initial, recipe.launchOptions ?? {}]])
  )
  const launchOptions = launchChoices.has(agent) ? launchChoices.get(agent)! : agent === initial ? recipe.launchOptions ?? {} : null
  const [text, setText] = useState(preview.prompt)
  const [args, setArgs] = useState(recipe.args)
  const [saveRecipe, setSaveRecipe] = useState(true)
  const [scope, setScope] = useState<'repo' | 'global'>('repo')
  const [starting, setStarting] = useState(false)

  const template = templateOf(text, preview.prompt, recipe.template)
  const optionsChanged =
    agent === initial
      ? !sameLaunchOptions(launchOptions, recipe.launchOptions)
      : hasLaunchChoices(recipe.launchOptions)
  const changed = agent !== initial || args !== recipe.args || template !== recipe.template || optionsChanged
  const hasSaved = Object.values(recipe.sources).some((source) => source !== 'default')
  const alreadySaved = !changed && hasSaved
  const saving = changed && saveRecipe
  const known = usable.some((entry) => entry.id === agent)

  const go = async () => {
    setStarting(true)
    const includeChoices = saving || optionsChanged || agent !== initial
    const started = await start({
      agent,
      args,
      template,
      ...(includeChoices ? { launchOptions } : {}),
      ...(saving ? { save: scope } : {})
    })
    setStarting(false)
    if (started) onClose()
  }

  return (
    <>
      <div className="form">
        <label>
          Agent
          {agents.list !== null && usable.length > 0 ? (
            <select aria-label="Agent" value={agent} onChange={(event) => setPicked(event.target.value)}>
              {!known && agent !== '' && <option value={agent}>{agent}</option>}
              {usable.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted scm-ai-status">{agents.settled ? 'No enabled agents' : 'Detecting agents...'}</span>
          )}
        </label>
        <div className="scm-ai-field">
          <div className="scm-ai-field-head">
            <label htmlFor="scm-ai-launch-template">Prompt template</label>
            <button type="button" disabled={text === DEFAULT_TEMPLATE} onClick={() => setText(DEFAULT_TEMPLATE)}>
              Reset
            </button>
          </div>
          <textarea
            id="scm-ai-launch-template"
            className="scm-ai-template"
            aria-label="Prompt template"
            rows={8}
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <label>
          CLI arguments
          <input type="text" aria-label="CLI arguments" spellCheck={false} value={args} onChange={(event) => setArgs(event.target.value)} />
        </label>
        <LaunchOptionsEditor
          context={context}
          agent={agent}
          value={launchOptions}
          args={args}
          onChange={(next) => setLaunchChoices((current) => {
            const choices = new Map(current)
            choices.set(agent, next)
            return choices
          })}
        />
        <div className="scm-ai-save">
          <label className="scm-ai-check">
            <input type="checkbox" aria-label="Save this launch as the recipe" checked={saveRecipe} onChange={(event) => setSaveRecipe(event.target.checked)} />
            <span>{alreadySaved ? 'Launch recipe already saved' : 'Save this launch as the recipe'}</span>
          </label>
          {saveRecipe && !alreadySaved && (
            <label>
              Save for
              <select aria-label="Save for" value={scope} onChange={(event) => setScope(event.target.value as 'repo' | 'global')}>
                <option value="repo">This repository</option>
                <option value="global">All repositories</option>
              </select>
            </label>
          )}
        </div>
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={agent === '' || usable.length === 0 || starting} onClick={() => void go()}>
          {saving ? 'Save & start agent' : 'Start agent'}
        </button>
      </div>
    </>
  )
}

/**
 * "Customize launch...": review the full prompt, agent and arguments of an AI Fix launch before
 * the agent starts, and optionally save them as the recipe for this repository or all of them.
 */
export function LaunchDialog(props: Props) {
  const { context, worktree, action, onClose } = props
  const agents = useAgents(context, true)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    context
      .call('quirky.git/aiFixPreview', { worktree, action })
      .then((result) => {
        if (alive) setPreview(result as Preview)
      })
      .catch((e: unknown) => {
        if (alive) setError(messageOf(e))
      })
    return () => {
      alive = false
    }
  }, [context, worktree, action])

  return (
    <Dialog title={TITLES[action]} onClose={onClose} wide>
      <p className="muted">Review and edit the full command input before starting an agent.</p>
      {preview !== null && <LaunchForm {...props} preview={preview} agents={agents} />}
      {preview === null && error === null && <p className="muted">Loading…</p>}
      {error !== null && (
        <>
          <p className="form-error" role="alert">
            {error}
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Dialog>
  )
}
