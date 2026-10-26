import type { ProjectSettings, RepoDetails } from '@quirky/protocol'
import type { Env } from './env'
import { effectiveHooks, hashScript, readHooksFile, sharedScripts, type TrustedHashes } from './hooks'
import { settingsFromJson, settingsToJson, toRepo, type HookKind, type RepoRow } from './store'

export type SetParams = {
  repo: string
  displayName?: string
  defaultBase?: string
  worktreeLocation?: string
  setupPolicy?: ProjectSettings['setupPolicy']
  agentStartup?: NonNullable<ProjectSettings['agentStartup']>
  commandSource?: NonNullable<ProjectSettings['commandSource']>
  setupScript?: string
  archiveScript?: string
}

const DEFAULT_REF = 'HEAD'

function trustedHashes(env: Env, repoId: string): TrustedHashes {
  const hashes: TrustedHashes = {}
  for (const row of env.store.all<{ kind: string; hash: string }>('SELECT kind, hash FROM trusted_hooks WHERE repo_id = ?', repoId)) {
    if (row.kind === 'setup' || row.kind === 'archive') hashes[row.kind] = row.hash
  }
  return hashes
}

function loadRow(env: Env, repoId: string): RepoRow {
  return env.store.get<RepoRow>('SELECT * FROM repos WHERE id = ?', repoId)!
}

/** The project, its settings and its hooks as read at `ref` (default `HEAD`). */
export async function details(env: Env, selector: string, ref = DEFAULT_REF): Promise<RepoDetails> {
  const row = loadRow(env, env.resolve(selector).id)
  const repo = toRepo(row)
  const file = repo.kind === 'git' ? await readHooksFile(repo.path, ref) : null
  const settings = settingsFromJson(row.settings)
  return { repo, settings, hooks: effectiveHooks(file, settings, trustedHashes(env, repo.id)) }
}

export const show = (env: Env, params: { repo: string }): Promise<RepoDetails> => details(env, params.repo)

export async function hooks(env: Env, params: { repo: string; ref?: string }) {
  return (await details(env, params.repo, params.ref)).hooks
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** Applies the given fields only; an empty string clears a string field. */
export async function set(env: Env, params: SetParams): Promise<RepoDetails> {
  const repo = env.resolve(params.repo)
  const row = loadRow(env, repo.id)
  const settings = settingsFromJson(row.settings)
  if (params.defaultBase !== undefined) settings.defaultBase = orNull(params.defaultBase)
  if (params.worktreeLocation !== undefined) settings.worktreeLocation = orNull(params.worktreeLocation)
  if (params.setupPolicy !== undefined) settings.setupPolicy = params.setupPolicy
  if (params.agentStartup !== undefined) settings.agentStartup = params.agentStartup
  if (params.commandSource !== undefined) settings.commandSource = params.commandSource
  if (params.setupScript !== undefined) settings.setupScript = params.setupScript.trim() === '' ? '' : params.setupScript
  if (params.archiveScript !== undefined) settings.archiveScript = params.archiveScript.trim() === '' ? '' : params.archiveScript
  const displayName = params.displayName === undefined ? row.display_name : orNull(params.displayName)
  env.store.run('UPDATE repos SET display_name = ?, settings = ? WHERE id = ?', displayName, settingsToJson(settings), repo.id)
  env.changed({ repoId: repo.id })
  return details(env, repo.id)
}

/** Approves the shared scripts now at `HEAD`, so setup and archive may run them. */
export async function trustHooks(env: Env, params: { repo: string; kind?: 'setup' | 'archive' | 'all' }): Promise<RepoDetails> {
  const repo = env.resolve(params.repo)
  const scripts = sharedScripts(repo.kind === 'git' ? await readHooksFile(repo.path, DEFAULT_REF) : null)
  const kinds: HookKind[] = params.kind === 'setup' || params.kind === 'archive' ? [params.kind] : ['setup', 'archive']
  env.store.transaction(() => {
    for (const kind of kinds) {
      const text = scripts[kind]
      if (text !== undefined) {
        env.store.run('INSERT OR REPLACE INTO trusted_hooks (repo_id, kind, hash) VALUES (?, ?, ?)', repo.id, kind, hashScript(text))
      }
    }
  })
  env.changed({ repoId: repo.id })
  return details(env, repo.id)
}
