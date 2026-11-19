import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The model and effort an agent's own settings name for a new session; null where they name none. */
export type HarnessDefaults = { model: string | null; effort: string | null }

export type HarnessDefaultsDeps = {
  env: Record<string, string | undefined>
  /** The user's home; `$HOME` first because Bun's `os.homedir()` ignores a changed `$HOME`. */
  home: string
  /** Claude Code's merged settings for `cwd`, as the CLI itself would see them. */
  claudeSettings: (cwd: string) => Promise<Record<string, unknown>>
  /** A file's text, or null when it cannot be read. */
  readText: (path: string) => string | null
}

const NONE: HarnessDefaults = { model: null, effort: null }

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

async function claude(cwd: string, deps: HarnessDefaultsDeps): Promise<HarnessDefaults> {
  const settings = await deps.claudeSettings(cwd)
  const effortEnv = text(deps.env.CLAUDE_CODE_EFFORT_LEVEL)
  return {
    model: text(deps.env.ANTHROPIC_MODEL) ?? text(settings.model),
    // "unset" tells the CLI to send no effort at all, which no launch flag can express
    effort: effortEnv === 'unset' ? null : effortEnv ?? text(settings.effortLevel)
  }
}

function codex(deps: HarnessDefaultsDeps): HarnessDefaults {
  const home = text(deps.env.CODEX_HOME) ?? join(deps.home, '.codex')
  const source = deps.readText(join(home, 'config.toml'))
  if (source === null) return NONE
  const config = record(Bun.TOML.parse(source))
  const profileName = text(config.profile)
  const profile = profileName === null ? {} : record(record(config.profiles)[profileName])
  return {
    model: text(profile.model) ?? text(config.model),
    effort: text(profile.model_reasoning_effort) ?? text(config.model_reasoning_effort)
  }
}

function pi(deps: HarnessDefaultsDeps): HarnessDefaults {
  const dir = text(deps.env.PI_CODING_AGENT_DIR) ?? join(deps.home, '.pi', 'agent')
  const source = deps.readText(join(dir, 'settings.json'))
  if (source === null) return NONE
  const settings = record(JSON.parse(source))
  const provider = text(settings.defaultProvider)
  const model = text(settings.defaultModel)
  return {
    model: model === null ? null : provider !== null && !model.includes('/') ? `${provider}/${model}` : model,
    effort: text(settings.defaultThinkingLevel)
  }
}

function omp(deps: HarnessDefaultsDeps): HarnessDefaults {
  const source = deps.readText(join(deps.home, '.omp', 'agent', 'config.yml'))
  if (source === null) return NONE
  const config = record(Bun.YAML.parse(source))
  const role = text(record(config.modelRoles).default)
  // a role reads provider/model:thinking; the suffix is the thinking level, not part of the id
  const colon = role === null ? -1 : role.lastIndexOf(':')
  const suffixed = role !== null && colon > role.lastIndexOf('/')
  return {
    model: role === null ? null : suffixed ? role.slice(0, colon) : role,
    effort: (suffixed ? text(role!.slice(colon + 1)) : null) ?? text(config.defaultThinkingLevel)
  }
}

/**
 * Reads the model and effort `agent`'s own settings give a new session started in `cwd`, so a chat can
 * launch on them explicitly and show them truthfully. Unreadable or malformed settings read as none.
 */
export async function harnessDefaults(agent: 'claude' | 'codex' | 'pi' | 'omp', cwd: string, deps: HarnessDefaultsDeps): Promise<HarnessDefaults> {
  try {
    if (agent === 'claude') return await claude(cwd, deps)
    if (agent === 'codex') return codex(deps)
    if (agent === 'pi') return pi(deps)
    return omp(deps)
  } catch {
    return NONE
  }
}

/** The real filesystem, environment and Claude settings resolver. */
export function systemHarnessDeps(): HarnessDefaultsDeps {
  return {
    env: process.env,
    home: process.env.HOME || homedir(),
    claudeSettings: async (cwd) => {
      const { resolveSettings } = await import('@anthropic-ai/claude-agent-sdk')
      return (await resolveSettings({ cwd })).effective as Record<string, unknown>
    },
    readText: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    }
  }
}
