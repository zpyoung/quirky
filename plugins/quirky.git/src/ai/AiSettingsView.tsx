import { useCallback, useEffect, useId, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { Button, EmptyState, FormRow, InlineError, NoticeLine, SectionHeader, TextField } from '@quirky/ui'
import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { isRecord } from '../daemon/validation'
import { messageOf } from '../panel/format'
import { worktreeOf } from '../scm'
import { SESSIONS_VIEW_ID } from '../shared/view-input'
import { generators, isUsable, useAgents, type AgentList } from './agents'
import { useDraft } from './useDraft'
import type { RecipeLaunchOptions } from '../daemon/recipe-options'
import { LaunchOptionsEditor } from './LaunchOptionsEditor'
import { CUSTOM_AGENT, DEFAULT_TEMPLATE, type AiAction, type NameAction, type Recipe } from './types'

const ACTIONS: ReadonlyArray<{ action: AiAction; title: string }> = [
  { action: 'commitMessage', title: 'Commit message' },
  { action: 'fixCommitFailure', title: 'Commit failure fixes' },
  { action: 'fixPushFailure', title: 'Push failure fixes' },
  { action: 'resolveConflicts', title: 'Conflict resolution' },
  { action: 'branchSummary', title: 'Branch summary' },
  { action: 'pullRequestDetails', title: 'Pull request details' },
  { action: 'pullRequestReview', title: 'Pull request review' },
  { action: 'reviewConversation', title: 'Review conversation' },
  { action: 'branchName', title: 'Branch name' },
  { action: 'conversationName', title: 'Conversation name' }
]

const SETTING = (name: string) => `setting:quirky.git/${name}`

type Recipes = Partial<Record<AiAction, Recipe>>

type RecipeState = { recipes: Recipes; loading: boolean; error: string | null }
type RecipeReadResult = { recipe: Recipe | null; error: string | null }

async function readRecipes(
  context: UiPluginContext,
  worktree: string,
  latest: MutableRefObject<number>,
  alive: MutableRefObject<boolean>,
  setState: Dispatch<SetStateAction<RecipeState>>
): Promise<void> {
  const request = ++latest.current
  setState((previous) => ({ ...previous, loading: true }))
  const results = await Promise.all(
    ACTIONS.map(async ({ action }): Promise<RecipeReadResult> => {
      try {
        return { recipe: (await context.call('quirky.git/aiRecipe', { worktree, action })) as Recipe | null, error: null }
      } catch (error) {
        return { recipe: null, error: messageOf(error) }
      }
    })
  )
  if (!alive.current || request !== latest.current) return
  const error = results.find((result) => result.error !== null)?.error
  const updates = results.flatMap((result): Array<[AiAction, Recipe]> =>
    result.recipe ? [[result.recipe.action, result.recipe]] : []
  )
  setState((previous) => ({
    recipes: Object.fromEntries([...Object.entries(previous.recipes), ...updates]) as Recipes,
    loading: false,
    error: error == null ? null : `Could not read the AI recipes: ${error}`
  }))
}

/** The recipes in effect for the worktree's repository, read again on every `aiChanged`. */
function useRecipes(context: UiPluginContext, worktree: string) {
  const [state, setState] = useState<RecipeState>({ recipes: {}, loading: true, error: null })
  const latest = useRef(0)
  const alive = useRef(false)
  function retryRecipes(): void {
    void readRecipes(context, worktree, latest, alive, setState)
  }
  useEffect(() => {
    alive.current = true
    void readRecipes(context, worktree, latest, alive, setState)
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.git/aiChanged' || event.type === 'quirky.agents/changed') {
        void readRecipes(context, worktree, latest, alive, setState)
      }
    })
    return () => {
      alive.current = false
      latest.current += 1
      unsubscribe()
    }
  }, [context, worktree, latest, alive, setState])
  const putRecipe = useCallback((recipe: Recipe) => {
    setState((previous) => ({ ...previous, recipes: { ...previous.recipes, [recipe.action]: recipe } }))
  }, [])
  return { ...state, put: putRecipe, retry: retryRecipes }
}

type AiSettings = { enabled: boolean; custom: string }

function readSettings(context: UiPluginContext): AiSettings {
  const read = (name: string): unknown => {
    try {
      return context.getSetting(name)
    } catch {
      return undefined
    }
  }
  return { enabled: read('ai-enabled') === true, custom: String(read('ai-custom-command') ?? '') }
}

/** The two AI settings, read again on every change to a `quirky.git` setting. */
function useAiSettings(context: UiPluginContext): AiSettings {
  const [settings, setSettings] = useState(() => readSettings(context))
  useEffect(() => {
    setSettings(readSettings(context))
    return context.subscribe((event) => {
      if (event.type === 'setting.changed' && event.id.startsWith('setting:quirky.git/')) setSettings(readSettings(context))
    })
  }, [context])
  return settings
}

type SectionProps = {
  context: UiPluginContext
  worktree: string
  action: AiAction
  title: string
  recipe: Recipe | undefined
  agents: AgentList | null
  onRecipe(recipe: Recipe): void
}

type NameSessionChoice = { id: string; label: string }

function nameSessionChoices(value: unknown, worktree: string): NameSessionChoice[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): NameSessionChoice[] => {
    if (!isRecord(item) || item.kind !== 'structured' || item.worktreeId !== worktree || typeof item.id !== 'string') return []
    return [{ id: item.id, label: typeof item.title === 'string' && item.title !== '' ? item.title : item.id }]
  })
}
type NameSessionState = { choices: NameSessionChoice[]; settled: boolean; error: string | null }

async function readNameSessions(
  context: UiPluginContext,
  worktree: string,
  latest: MutableRefObject<number>,
  setState: Dispatch<SetStateAction<NameSessionState>>
): Promise<void> {
  const request = ++latest.current
  try {
    const value = await context.call('quirky.session/list', { worktree })
    if (request === latest.current) setState({ choices: nameSessionChoices(value, worktree), settled: true, error: null })
  } catch (error) {
    if (request === latest.current) {
      setState((previous) => ({ ...previous, settled: true, error: messageOf(error) }))
    }
  }
}

function NameActionControls({ context, worktree, action, agent, args, template, launchOptions }: {
  context: UiPluginContext
  worktree: string
  action: NameAction
  agent: string
  args: string
  template: string
  launchOptions: RecipeLaunchOptions | null
}) {
  const [sessions, setSessions] = useState<NameSessionState>({ choices: [], settled: false, error: null })
  const [session, setSession] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const sessionId = useId()
  const [working, setWorking] = useState(false)
  const latestSessions = useRef(0)
  function retrySessions(): void {
    void readNameSessions(context, worktree, latestSessions, setSessions)
  }
  useEffect(() => {
    setSession('')
    setName('')
    void readNameSessions(context, worktree, latestSessions, setSessions)
    return () => {
      latestSessions.current += 1
    }
  }, [context, worktree, action, latestSessions])

  const generate = async () => {
    setWorking(true)
    setError(null)
    try {
      const result = await context.call('quirky.git/aiName', {
        worktree,
        action,
        ...(agent === '' ? {} : { agent }),
        args,
        template,
        launchOptions,
        ...(session === '' ? {} : { session })
      })
      if (!isRecord(result) || typeof result.name !== 'string') throw new Error('Name generation returned invalid data.')
      setName(result.name)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="ui-stack">
      <FormRow label={action === 'conversationName' ? 'Captured conversation' : 'Work prompt conversation (optional)'} htmlFor={sessionId}>
        <select id={sessionId} className="ui-text-field__input" aria-label={action === 'conversationName' ? 'Captured conversation' : 'Work prompt conversation (optional)'} value={session} onChange={(event) => {
          setSession(event.target.value)
          setName('')
        }}>
          <option value="">{action === 'conversationName' ? 'Select a conversation' : 'Use Git changes only'}</option>
          {sessions.choices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </FormRow>
      {action === 'conversationName' && sessions.settled && sessions.error === null && sessions.choices.length === 0 && (
        <EmptyState message="No captured conversations in this worktree." />
      )}
      {sessions.error !== null && <InlineError message={sessions.error} action={{ label: 'Retry', onAction: retrySessions }} />}
      <Button type="button" disabled={working || agent === '' || (action === 'conversationName' && session === '')} onClick={() => void generate()}>
        {working ? 'Generating name…' : action === 'branchName' ? 'Generate branch name' : 'Generate conversation name'}
      </Button>
      {name !== '' && <TextField label="Suggested name" readOnly value={name} />}
      {error !== null && <InlineError message={error} />}
    </div>
  )
}

function ActionSection({ context, worktree, action, title, recipe, agents, onRecipe }: SectionProps) {
  const choices = agents === null ? [] :
    action === 'commitMessage' || action === 'branchName' || action === 'conversationName'
      ? generators(agents)
      : agents.agents.filter(isUsable)
  const fallback = agents === null ? '' : choices.find((choice) => choice.id === agents.defaultAgent)?.id ?? choices[0]?.id ?? ''
  async function persist(fields: { agent?: string; args?: string; template?: string; launchOptions?: RecipeLaunchOptions | null }): Promise<void> {
    try {
      const result = (await context.call('quirky.git/setAiRecipe', { worktree, action, scope: 'global', ...fields })) as { recipe: Recipe }
      onRecipe(result.recipe)
    } catch (error) {
      context.toast('Could not save the AI recipe', messageOf(error), { kind: 'error' })
    }
  }
  async function saveAgent(next: string): Promise<void> {
    const oldProvider = (recipe?.agent ?? '') || fallback
    const nextProvider = next || fallback
    await persist({ agent: next, ...(oldProvider === nextProvider ? {} : { launchOptions: null }) })
  }
  function saveArgs(next: string): Promise<void> {
    return persist({ args: next })
  }
  function saveTemplate(next: string): Promise<void> {
    return persist({ template: next })
  }
  const [agent, changeAgent] = useDraft(recipe?.agent ?? '')
  const [args, changeArgs] = useDraft(recipe?.args ?? '')
  const [template, changeTemplate] = useDraft(recipe?.template ?? DEFAULT_TEMPLATE)
  const provider = agent || fallback
  const optionValue = agent === (recipe?.agent ?? '') ? recipe?.launchOptions ?? {} : {}
  const listed = choices.some((choice) => choice.id === agent) || agent === '' || (action === 'commitMessage' && agent === CUSTOM_AGENT)
  const overridden = recipe !== undefined && Object.values(recipe.sources).includes('repo')
  const agentId = useId()
  const templateId = useId()

  return (
    <section className="ui-stack" data-action={action}>
      <h3>{title}</h3>
      {overridden && <p className="ui-text-muted">This repository has its own recipe, which takes precedence here.</p>}
      <FormRow label="Agent" htmlFor={agentId}>
        <select
          id={agentId}
          className="ui-text-field__input"
          aria-label={`${title} agent`}
          value={agent}
          onChange={(event) => changeAgent(event.target.value, saveAgent)}
        >
          <option value="">Default agent</option>
          {!listed && <option value={agent}>{agent}</option>}
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
          {action === 'commitMessage' && <option value={CUSTOM_AGENT}>Custom command</option>}
        </select>
      </FormRow>
      <TextField
        label="CLI arguments"
        type="text"
        aria-label={`${title} CLI arguments`}
        spellCheck={false}
        value={args}
        onChange={(event) => changeArgs(event.target.value, saveArgs)}
      />
      <LaunchOptionsEditor
        key={`${action}:${provider}`}
        host="local"
        context={context}
        agent={provider}
        value={optionValue}
        args={args}
        labelPrefix={title}
        resetLabel="Use inherited launch choices"
        onChange={(launchOptions) => void persist({ launchOptions })}
      />
      <div className="ui-stack">
        <FormRow label="Command template" htmlFor={templateId}>
          <textarea
            id={templateId}
            className="ui-text-field__input"
            aria-label={`${title} command template`}
            rows={4}
            spellCheck={false}
            value={template}
            onChange={(event) => changeTemplate(event.target.value, saveTemplate)}
          />
        </FormRow>
        <div className="ui-cluster">
          <Button type="button" disabled={template === DEFAULT_TEMPLATE} onClick={() => changeTemplate(DEFAULT_TEMPLATE, saveTemplate, '')}>
            Reset
          </Button>
        </div>
      </div>
      {action === 'branchName' && (
        <NameActionControls context={context} worktree={worktree} action="branchName" agent={provider} args={args} template={template} launchOptions={optionValue} />
      )}
      {action === 'conversationName' && (
        <NameActionControls context={context} worktree={worktree} action="conversationName" agent={provider} args={args} template={template} launchOptions={optionValue} />
      )}
    </section>
  )
}

function inputWorktree(input: unknown): string | null {
  const worktree = typeof input === 'object' && input !== null ? (input as { worktree?: unknown }).worktree : undefined
  return typeof worktree === 'string' && worktree !== '' ? worktree : null
}

function AiSettingsView({ context, input }: { context: UiPluginContext; input: unknown }) {
  const worktree = inputWorktree(input) ?? worktreeOf(context.getLayout())
  if (worktree === null) return <EmptyState message="Open a worktree first." />
  return <AiSettingsBody context={context} worktree={worktree} />
}

function AiSettingsBody({ context, worktree }: { context: UiPluginContext; worktree: string }) {
  const settings = useAiSettings(context)
  const agents = useAgents(context, true)
  const recipeState = useRecipes(context, worktree)
  const { recipes, put: putRecipe, retry: retryRecipes, loading: recipesLoading, error: recipeError } = recipeState
  const [enabled, setEnabled] = useState(settings.enabled)
  useEffect(() => setEnabled(settings.enabled), [settings.enabled])

  async function write(name: string, value: boolean | string): Promise<void> {
    try {
      await context.call('setting.set', { id: SETTING(name), value })
    } catch (error) {
      context.toast('Could not change the setting', messageOf(error), { kind: 'error' })
      setEnabled(readSettings(context).enabled)
    }
  }
  function saveCustom(next: string): Promise<void> {
    return write('ai-custom-command', next)
  }
  const [custom, changeCustom] = useDraft(settings.custom)
  const switchId = useId()

  return (
    <div className="ui-stack">
      <SectionHeader
        title="Source Control AI defaults"
        actions={<Button type="button" onClick={() => context.openView(SESSIONS_VIEW_ID, { worktree })}>Close</Button>}
      />
      {(recipesLoading || !agents.settled) && <div role="status"><NoticeLine>Loading AI settings…</NoticeLine></div>}
      {recipeError !== null && <InlineError message={recipeError} action={{ label: 'Retry', onAction: retryRecipes }} />}
      {agents.error !== null && (
        <InlineError message={`Could not read the agents: ${agents.error}`} action={{ label: 'Retry', onAction: agents.retry }} />
      )}
      <FormRow label="Show Source Control AI actions" htmlFor={switchId}>
        <input
          id={switchId}
          type="checkbox"
          role="switch"
          aria-label="Show Source Control AI actions"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked)
            void write('ai-enabled', event.target.checked)
          }}
        />
      </FormRow>
      <p className="ui-text-muted">Adds AI buttons that run the selected agent with the command template for that action.</p>
      <TextField
        label="Custom command"
        type="text"
        aria-label="Custom command"
        spellCheck={false}
        value={custom}
        onChange={(event) => changeCustom(event.target.value, saveCustom)}
        help="Command line Quirky runs when a recipe uses Custom command."
      />
      {ACTIONS.map(({ action, title }) => (
        <ActionSection key={action} context={context} worktree={worktree} action={action} title={title} recipe={recipes[action]} agents={agents.list} onRecipe={putRecipe} />
      ))}
    </div>
  )
}

/** The `view:quirky.git/ai-settings` mount function; the input names the worktree whose repository's recipes show. */
export function mountAiSettings(context: UiPluginContext): MountFunction {
  return (element, { input }) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' })
    const root = createRoot(element)
    root.render(<AiSettingsView context={context} input={input} />)
    return () => root.unmount()
  }
}
