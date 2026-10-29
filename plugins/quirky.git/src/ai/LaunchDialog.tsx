import { useEffect, useId, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Button, Dialog, FormRow, TextField } from '@quirky/ui'
import { messageOf } from '../panel/format'
import { initialAgent, isUsable, useAgents } from './agents'
import { DEFAULT_TEMPLATE, type FixAction, type LaunchParams, type Recipe } from './types'
import type { RecipeLaunchOptions } from '../daemon/recipe-options'
import { LaunchOptionsEditor } from './LaunchOptionsEditor'

const TITLES: Readonly<Record<FixAction, string>> = {
  fixCommitFailure: 'Fix Commit Failure With AI',
  fixPushFailure: 'Fix Push Failure With AI',
  resolveConflicts: 'Resolve Conflicts With AI',
  branchSummary: 'Summarize Branch With AI',
  pullRequestDetails: 'Summarize Pull Request With AI',
  pullRequestReview: 'Review Pull Request With AI',
  reviewConversation: 'Draft Pull Request Conversation Reply'
}

type Preview = { prompt: string; recipe: Recipe }

type Props = {
  context: UiPluginContext
  worktree: string
  action: FixAction
  onClose(): void
  /** Starts the agent; resolves with null once it started, or why not, which keeps the dialog open. */
  start(launch: LaunchParams): Promise<string | null>
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
  const [failure, setFailure] = useState<string | null>(null)
  const agentId = useId()
  const templateId = useId()
  const saveRecipeId = useId()
  const saveForId = useId()

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
    setFailure(null)
    const includeChoices = saving || optionsChanged || agent !== initial
    const refusal = await start({
      agent,
      args,
      template,
      ...(includeChoices ? { launchOptions } : {}),
      ...(saving ? { save: scope } : {})
    })
    setStarting(false)
    if (refusal === null) onClose()
    else setFailure(refusal)
  }

  return (
    <>
      <div className="ui-stack">
        {agents.list !== null && usable.length > 0 ? (
          <FormRow label="Agent" htmlFor={agentId}>
            <select id={agentId} className="ui-text-field__input" aria-label="Agent" value={agent} onChange={(event) => setPicked(event.target.value)}>
              {!known && agent !== '' && <option value={agent}>{agent}</option>}
              {usable.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </FormRow>
        ) : (
          <div className="ui-stack">
            <span className="ui-text-field__label">Agent</span>
            <span className="ui-text-muted">{agents.settled ? 'No enabled agents' : 'Detecting agents...'}</span>
          </div>
        )}
        <div className="ui-stack">
          <FormRow label="Prompt template" htmlFor={templateId}>
            <textarea
              id={templateId}
              className="ui-text-field__input"
              aria-label="Prompt template"
              rows={8}
              spellCheck={false}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </FormRow>
          <div className="ui-cluster">
            <Button type="button" disabled={text === DEFAULT_TEMPLATE} onClick={() => setText(DEFAULT_TEMPLATE)}>
              Reset
            </Button>
          </div>
        </div>
        <TextField label="CLI arguments" type="text" aria-label="CLI arguments" spellCheck={false} value={args} onChange={(event) => setArgs(event.target.value)} />
        <LaunchOptionsEditor
          context={context}
          host="local"
          agent={agent}
          value={launchOptions}
          args={args}
          onChange={(next) => setLaunchChoices((current) => {
            const choices = new Map(current)
            choices.set(agent, next)
            return choices
          })}
        />
        <div className="ui-stack">
          <FormRow label={alreadySaved ? 'Launch recipe already saved' : 'Save this launch as the recipe'} htmlFor={saveRecipeId}>
            <input
              id={saveRecipeId}
              type="checkbox"
              aria-label="Save this launch as the recipe"
              checked={saveRecipe}
              onChange={(event) => setSaveRecipe(event.target.checked)}
            />
          </FormRow>
          {saveRecipe && !alreadySaved && (
            <FormRow label="Save for" htmlFor={saveForId}>
              <select id={saveForId} className="ui-text-field__input" aria-label="Save for" value={scope} onChange={(event) => setScope(event.target.value as 'repo' | 'global')}>
                <option value="repo">This repository</option>
                <option value="global">All repositories</option>
              </select>
            </FormRow>
          )}
        </div>
      </div>
      {failure !== null && (
        <p className="ui-error-text" role="alert">
          {failure}
        </p>
      )}
      <div className="ui-cluster">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="button" variant="primary" disabled={agent === '' || usable.length === 0 || starting} onClick={() => void go()}>
          {saving ? 'Save & start agent' : 'Start agent'}
        </Button>
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
    <Dialog open title={TITLES[action]} onClose={onClose}>
      <p className="ui-text-muted">Review and edit the full command input before starting an agent.</p>
      {preview !== null && <LaunchForm {...props} preview={preview} agents={agents} />}
      {preview === null && error === null && <p className="ui-text-muted">Loading…</p>}
      {error !== null && (
        <>
          <p className="ui-error-text" role="alert">
            {error}
          </p>
          <div className="ui-cluster">
            <Button type="button" onClick={onClose}>Cancel</Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
