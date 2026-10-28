import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { messageOf } from '../panel/format'
import { worktreeOf } from '../scm'
import { SESSIONS_VIEW_ID } from '../shared/view-input'
import { generators, isUsable, useAgents, type AgentList } from './agents'
import { useDraft } from './useDraft'
import type { RecipeLaunchOptions } from '../daemon/recipe-options'
import { LaunchOptionsEditor } from './LaunchOptionsEditor'
import { CUSTOM_AGENT, DEFAULT_TEMPLATE, type AiAction, type Recipe } from './types'

const ACTIONS: ReadonlyArray<{ action: AiAction; title: string }> = [
  { action: 'commitMessage', title: 'Commit message' },
  { action: 'fixCommitFailure', title: 'Commit failure fixes' },
  { action: 'fixPushFailure', title: 'Push failure fixes' },
  { action: 'resolveConflicts', title: 'Conflict resolution' },
  { action: 'branchSummary', title: 'Branch summary' },
  { action: 'pullRequestDetails', title: 'Pull request details' },
  { action: 'pullRequestReview', title: 'Pull request review' },
  { action: 'reviewConversation', title: 'Review conversation' }
]

const SETTING = (name: string) => `setting:quirky.git/${name}`

type Recipes = Partial<Record<AiAction, Recipe>>

/** The recipes in effect for the worktree's repository, read again on every `aiChanged`. */
function useRecipes(context: UiPluginContext, worktree: string): [Recipes, (recipe: Recipe) => void] {
  const [recipes, setRecipes] = useState<Recipes>({})
  useEffect(() => {
    let alive = true
    const read = async () => {
      const results = await Promise.all(
        ACTIONS.map(async ({ action }) => {
          try {
            return (await context.call('quirky.git/aiRecipe', { worktree, action })) as Recipe
          } catch (error) {
            context.toast('Could not read the AI recipes', messageOf(error))
            return null
          }
        })
      )
      if (!alive) return
      setRecipes((prev) => {
        const next: Recipes = { ...prev }
        for (const recipe of results) if (recipe) next[recipe.action] = recipe
        return next
      })
    }
    void read()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.git/aiChanged' || event.type === 'quirky.agents/changed') void read()
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [context, worktree])
  const put = useCallback((recipe: Recipe) => setRecipes((prev) => ({ ...prev, [recipe.action]: recipe })), [])
  return [recipes, put]
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

function ActionSection({ context, worktree, action, title, recipe, agents, onRecipe }: SectionProps) {
  const choices = agents === null ? [] : action === 'commitMessage' ? generators(agents) : agents.agents.filter(isUsable)
  const fallback = agents === null ? '' : choices.find((choice) => choice.id === agents.defaultAgent)?.id ?? choices[0]?.id ?? ''
  const persist = async (fields: { agent?: string; args?: string; template?: string; launchOptions?: RecipeLaunchOptions | null }) => {
    try {
      const result = (await context.call('quirky.git/setAiRecipe', { worktree, action, scope: 'global', ...fields })) as { recipe: Recipe }
      onRecipe(result.recipe)
    } catch (error) {
      context.toast('Could not save the AI recipe', messageOf(error))
    }
  }
  const [agent, changeAgent] = useDraft(recipe?.agent ?? '', (next) => {
    const oldProvider = (recipe?.agent ?? '') || fallback
    const nextProvider = next || fallback
    return persist({ agent: next, ...(oldProvider === nextProvider ? {} : { launchOptions: null }) })
  })
  const [args, changeArgs] = useDraft(recipe?.args ?? '', (next) => persist({ args: next }))
  const [template, changeTemplate] = useDraft(recipe?.template ?? DEFAULT_TEMPLATE, (next) => persist({ template: next }))
  const provider = agent || fallback
  const optionValue = agent === (recipe?.agent ?? '') ? recipe?.launchOptions ?? {} : {}
  const listed = choices.some((choice) => choice.id === agent) || agent === '' || (action === 'commitMessage' && agent === CUSTOM_AGENT)
  const overridden = recipe !== undefined && Object.values(recipe.sources).includes('repo')

  return (
    <section className="scm-ai-action" data-action={action}>
      <h3>{title}</h3>
      {overridden && <p className="muted scm-ai-hint">This repository has its own recipe, which takes precedence here.</p>}
      <label>
        Agent
        <select aria-label={`${title} agent`} value={agent} onChange={(event) => changeAgent(event.target.value)}>
          <option value="">Default agent</option>
          {!listed && <option value={agent}>{agent}</option>}
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
          {action === 'commitMessage' && <option value={CUSTOM_AGENT}>Custom command</option>}
        </select>
      </label>
      <label>
        CLI arguments
        <input type="text" aria-label={`${title} CLI arguments`} spellCheck={false} value={args} onChange={(event) => changeArgs(event.target.value)} />
      </label>
      <LaunchOptionsEditor
        key={`${action}:${provider}`}
        context={context}
        agent={provider}
        value={optionValue}
        args={args}
        labelPrefix={title}
        resetLabel="Use inherited launch choices"
        onChange={(launchOptions) => void persist({ launchOptions })}
      />
      <div className="scm-ai-field">
        <div className="scm-ai-field-head">
          <label>Command template</label>
          <button type="button" disabled={template === DEFAULT_TEMPLATE} onClick={() => changeTemplate(DEFAULT_TEMPLATE, '')}>
            Reset
          </button>
        </div>
        <textarea
          className="scm-ai-template"
          aria-label={`${title} command template`}
          rows={4}
          spellCheck={false}
          value={template}
          onChange={(event) => changeTemplate(event.target.value)}
        />
      </div>
    </section>
  )
}

function inputWorktree(input: unknown): string | null {
  const worktree = typeof input === 'object' && input !== null ? (input as { worktree?: unknown }).worktree : undefined
  return typeof worktree === 'string' && worktree !== '' ? worktree : null
}

function AiSettingsView({ context, input }: { context: UiPluginContext; input: unknown }) {
  const worktree = inputWorktree(input) ?? worktreeOf(context.getLayout())
  if (worktree === null) return <p className="muted pad">Open a worktree first.</p>
  return <AiSettingsBody context={context} worktree={worktree} />
}

function AiSettingsBody({ context, worktree }: { context: UiPluginContext; worktree: string }) {
  const settings = useAiSettings(context)
  const agents = useAgents(context, true)
  const [recipes, putRecipe] = useRecipes(context, worktree)
  const [enabled, setEnabled] = useState(settings.enabled)
  useEffect(() => setEnabled(settings.enabled), [settings.enabled])

  const write = async (name: string, value: boolean | string) => {
    try {
      await context.call('setting.set', { id: SETTING(name), value })
    } catch (error) {
      context.toast('Could not change the setting', messageOf(error))
      setEnabled(readSettings(context).enabled)
    }
  }
  const [custom, changeCustom] = useDraft(settings.custom, (next) => write('ai-custom-command', next))

  return (
    <div className="scm-ai-view">
      <header className="scm-ai-view-head">
        <h2>Source Control AI defaults</h2>
        <button type="button" onClick={() => context.openView(SESSIONS_VIEW_ID, { worktree })}>
          Close
        </button>
      </header>
      <label className="scm-ai-check scm-ai-switch">
        <input
          type="checkbox"
          role="switch"
          aria-label="Show Source Control AI actions"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked)
            void write('ai-enabled', event.target.checked)
          }}
        />
        <span>Show Source Control AI actions</span>
      </label>
      <p className="muted">Adds AI buttons that run the selected agent with the command template for that action.</p>
      <label>
        Custom command
        <input type="text" aria-label="Custom command" spellCheck={false} value={custom} onChange={(event) => changeCustom(event.target.value)} />
      </label>
      <p className="muted">Command line Quirky runs when a recipe uses Custom command.</p>
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
