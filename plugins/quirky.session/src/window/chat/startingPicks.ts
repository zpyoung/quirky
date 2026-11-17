import type { UiPluginContext } from '@quirky/protocol'
import { agentOptionsOf, effortChoices, effortOption, type AgentOptions, type Picks } from './controls'

/** What the agent's own settings name for a new session, from `quirky.structured/defaults`; null where they name none. */
export type HarnessDefaults = { model: string | null; effort: string | null }

export const NO_HARNESS_DEFAULTS: HarnessDefaults = { model: null, effort: null }

type ModelAndEffort = Pick<Picks, 'model' | 'effort'>

const accepts = (options: AgentOptions, model: string) => options.unlisted === 'accept' || options.models.some((entry) => entry.id === model)
const offers = (options: AgentOptions, model: string, effort: string) => effortChoices(options, model).some((choice) => choice.value === effort)

/**
 * The model and effort a new chat launches with. A user pick wins; then what the agent's own settings
 * name; then the catalog's declared default, only when the settings name nothing, so a chat never
 * launches on a model the user's settings did not choose. A value the catalog cannot launch with is
 * left to the agent (null), and a default effort applies only to a known model that offers it.
 * Without a catalog the picks pass as they are.
 */
export function startingPicks(options: AgentOptions | null, harness: HarnessDefaults, picks: ModelAndEffort): ModelAndEffort {
  if (options === null) return { model: picks.model, effort: picks.effort }
  const model =
    picks.model ??
    (harness.model !== null ? (accepts(options, harness.model) ? harness.model : null) : options.defaultModel)
  if (picks.effort !== null || model === null) return { model, effort: picks.effort }
  const wanted = harness.effort ?? effortOption(options, model)?.default ?? null
  return { model, effort: wanted !== null && offers(options, model, wanted) ? wanted : null }
}

/**
 * Loads the catalog and the agent's settings for a chat in `worktree` and resolves its starting model
 * and effort. A source that cannot be read counts as naming nothing.
 */
export async function loadStartingPicks(
  context: UiPluginContext,
  agent: string,
  worktree: string,
  picks: ModelAndEffort
): Promise<{ options: AgentOptions | null; picks: ModelAndEffort }> {
  const [options, harness] = await Promise.all([
    context.call('quirky.agents/options', { agent }).then(agentOptionsOf, () => null),
    context.call('quirky.structured/defaults', { agent, worktree }).then(harnessDefaultsOf, () => NO_HARNESS_DEFAULTS)
  ])
  return { options, picks: startingPicks(options, harness, picks) }
}

function harnessDefaultsOf(loaded: unknown): HarnessDefaults {
  const found = loaded as Partial<HarnessDefaults> | undefined
  return {
    model: typeof found?.model === 'string' && found.model !== '' ? found.model : null,
    effort: typeof found?.effort === 'string' && found.effort !== '' ? found.effort : null
  }
}
