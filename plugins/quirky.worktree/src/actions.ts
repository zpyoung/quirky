import { RpcErrorCode, type FolderPickerRequest, type FolderPickerResult, type UiPluginContext, type Worktree, type WorktreeCreateResult, type WorktreeRemoveResult } from '@quirky/protocol'

export const SESSION_VIEW = 'view:quirky.session/worktree'

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reasonOf(error: unknown): string | undefined {
  const reason = (error as { data?: { reason?: unknown } } | null)?.data?.reason
  return typeof reason === 'string' ? reason : undefined
}
export class FolderPickerUnavailableError extends Error {
  readonly code = RpcErrorCode.Conflict
  readonly reason = 'native-folder-picker-unavailable'

  constructor() {
    super('This shell does not provide the native folder picker.')
    this.name = 'FolderPickerUnavailableError'
  }
}
/** Returns this plugin call's exact kernel UI connection, never the focused window's identity. */
export async function currentWindowId(context: UiPluginContext): Promise<number> {
  const value = await context.call('ui.window.self', {})
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'connId' in value) {
    const connId = value.connId
    if (typeof connId === 'number' && Number.isSafeInteger(connId) && connId > 0) return connId
  }
  throw new Error('ui.window.self returned an invalid connection identity.')
}

/** Calls the shell-owned native folder picker, returning null on cancellation. */
export async function pickNativeFolder(context: UiPluginContext, title: string, startingFolder?: string): Promise<string | null> {
  let result: unknown
  try {
    const request: FolderPickerRequest & { multiple: false } = {
      title,
      ...(startingFolder ? { startingFolder } : {}),
      multiple: false
    }
    result = await context.call('desktop.folder.pick', request as Record<string, unknown>)
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    const reason = (error as { data?: { reason?: unknown } } | null)?.data?.reason
    const unavailableConflict = code === RpcErrorCode.Conflict && typeof reason === 'string' &&
      reason.toLowerCase().includes('folder') && reason.toLowerCase().includes('picker') && reason.toLowerCase().includes('unavailable')
    if (code === RpcErrorCode.MethodNotFound || unavailableConflict) throw new FolderPickerUnavailableError()
    throw error
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('desktop.folder.pick returned an invalid result.')
  }
  const picked = result as Partial<FolderPickerResult>
  if (typeof picked.cancelled !== 'boolean' || !Array.isArray(picked.paths) || !picked.paths.every((path) => typeof path === 'string')) {
    throw new Error('desktop.folder.pick returned an invalid result.')
  }
  if (picked.cancelled) return null
  if (picked.paths.length !== 1 || picked.paths[0] === '') {
    throw new Error('desktop.folder.pick must return exactly one folder when not cancelled.')
  }
  return picked.paths[0] as string
}

/** Hands the new-worktree command's request to the sidebar section, now or when it next mounts. */
export type CreateRequest = { repoId?: string }

export type CreateRequests = {
  request(request: CreateRequest): void
  /** Delivers any request waiting for a section; the returned function detaches it. */
  attach(listener: (request: CreateRequest) => void): () => void
}

export function createRequests(): CreateRequests {
  let listener: ((request: CreateRequest) => void) | null = null
  let queued: CreateRequest | null = null
  return {
    request(request) {
      if (listener) listener(request)
      else queued = request
    },
    attach(next) {
      listener = next
      if (queued) {
        const waiting = queued
        queued = null
        next(waiting)
      }
      return () => {
        if (listener === next) listener = null
      }
    }
  }
}

/** What adding a path came to: it is in, it is not a repository, or a toast said why it failed. */
export type AddOutcome = 'added' | 'not-a-repository' | 'failed'

/** Adds the project at `path`, as a plain folder with `folder`. */
export async function addProject(context: UiPluginContext, path: string, folder = false): Promise<AddOutcome> {
  try {
    await context.call('quirky.repo/add', { path, ...(folder ? { folder: true } : {}) })
    return 'added'
  } catch (error) {
    if (reasonOf(error) === 'not-a-repository') return 'not-a-repository'
    context.toast('Could not add project', messageOf(error))
    return 'failed'
  }
}

/** How many repositories sit under `path`; null after a toast says the scan failed. */
export async function scanFolder(context: UiPluginContext, path: string): Promise<number | null> {
  try {
    const found = (await context.call('quirky.repo/scan', { path })) as { repos: unknown[] }
    return found.repos.length
  } catch (error) {
    context.toast('Could not add project', messageOf(error))
    return null
  }
}

/** Adds every repository under `path`, as one group named `group` when given; true unless the call failed. */
export async function importFolder(context: UiPluginContext, path: string, group?: string): Promise<boolean> {
  try {
    const result = (await context.call('quirky.repo/import', { path, ...(group ? { group } : {}) })) as {
      failed: number
      results: { path: string; status: string; error?: string }[]
    }
    if (result.failed > 0) {
      const first = result.results.find((r) => r.status === 'failed')
      context.toast('Some repositories could not be added', first?.error ? `${first.path}: ${first.error}` : `${result.failed} failed`)
    }
    return true
  } catch (error) {
    context.toast('Could not add project', messageOf(error))
    return false
  }
}

/** Forgets the project (its folders stay); true on success, else a toast says why. */
export async function removeProject(context: UiPluginContext, repoId: string, expectedLedgers?: { ledgerId: string; revision: number }[]): Promise<boolean> {
  try {
    await context.call('quirky.repo/remove', {
      repo: repoId,
      ...(expectedLedgers === undefined ? {} : { expectedLedgers })
    })
    return true
  } catch (error) {
    context.toast('Could not remove project', messageOf(error))
    return false
  }
}

/** Runs a group change; true on success, else a toast titled `failure` says why. */
export async function changeGroup(context: UiPluginContext, failure: string, steps: () => Promise<unknown>): Promise<boolean> {
  try {
    await steps()
    return true
  } catch (error) {
    context.toast(failure, messageOf(error))
    return false
  }
}

/** What the trust dialog needs to ask about an untrusted shared setup or issue command. */
export type TrustRequest = { repoId: string; kind: 'setup' | 'issue'; script: string; changed: boolean }

/** The person's answer: run it this once, don't run it, trust it from now on, or abandon the create. */
export type TrustChoice = 'run' | 'skip' | 'always' | 'cancel'

export type CreateHooks = {
  askTrust(request: TrustRequest): Promise<TrustChoice>
  showFallback(worktreeId: string, message: string): void
}

/** What `createWorkspace` returns when the chosen start point has a setup script the form never offered a choice for. */
export const SETUP_CHOICE_NEEDED = 'setup-choice-needed'

/**
 * Creates a workspace from the window. The new workspace opens only when the open view is still the
 * one the person submitted from, else a toast names it. An untrusted shared setup script or issue
 * command is put to the person and the create retried with their answer. Returns the result,
 * `SETUP_CHOICE_NEEDED` when the daemon wants a run-or-skip answer the form can still collect, or
 * null after a toast says why nothing was created (or the person backed out of the trust question).
 */
export async function createWorkspace(
  context: UiPluginContext,
  fields: Record<string, unknown>,
  hooks: CreateHooks
): Promise<WorktreeCreateResult | typeof SETUP_CHOICE_NEEDED | null> {
  const window = await currentWindowId(context)
  const viewAtSubmit = JSON.stringify(context.getLayout().view)
  const choices: { trustSetup?: true; trustSetupHash?: string; trustIssueCommand?: true; trustIssueCommandHash?: string; setup?: 'skip'; issueCommand?: 'skip' } = {}
  let attempt = fields
  for (;;) {
    try {
      const result = (await context.call('quirky.worktree/create', { ...attempt, createdBy: 'window' })) as WorktreeCreateResult
      if (JSON.stringify(context.getLayout().view) === viewAtSubmit) {
        try {
          await context.call('quirky.worktree/navigate', { worktree: result.worktree.id, window })
        } catch (error) {
          context.toast('Created worktree but could not open it', messageOf(error))
        }
      }
      else context.toast(`Created ${result.worktree.name}`, result.worktree.path)
      if (result.baseFallback) hooks.showFallback(result.worktree.id, result.baseFallback.message)
      const receipt = (result as WorktreeCreateResult & {
        creationReceipt?: {
          sparsePaths?: string[]
          sharedDirectories?: string[]
          main?: { status: string; reason?: string; to?: string }
          agentLaunch?: { launchSettings: { summary?: string } | null }
        }
      }).creationReceipt
      const receiptLines: string[] = []
      if (receipt?.sparsePaths?.length) receiptLines.push(`Sparse checkout: ${receipt.sparsePaths.join(', ')}`)
      if (receipt?.sharedDirectories?.length) receiptLines.push(`Shared paths linked: ${receipt.sharedDirectories.join(', ')}`)
      if (receipt?.main?.status === 'fast-forwarded') receiptLines.push(`Primary checkout fast-forwarded to ${receipt.main.to ?? 'the selected base'}.`)
      else if (receipt?.main?.status === 'already-current') receiptLines.push('Primary checkout was already at the selected base.')
      else if (receipt?.main?.status === 'not-updated') receiptLines.push(`Primary checkout left unchanged (${receipt.main.reason ?? 'not safe to update'}).`)
      if (receipt?.agentLaunch?.launchSettings?.summary) receiptLines.push(`Agent launch: ${receipt.agentLaunch.launchSettings.summary}`)
      if (receiptLines.length > 0) context.toast(`Created ${result.worktree.name}`, receiptLines.join('\n'))
      return result
    } catch (error) {
      if (reasonOf(error) === 'setup-decision-required') return SETUP_CHOICE_NEEDED
      if (reasonOf(error) !== 'hooks-untrusted') {
        context.toast('Could not create worktree', messageOf(error))
        return null
      }
      const rawData = error !== null && typeof error === 'object' && 'data' in error ? error.data : undefined
      const data: Record<string, unknown> = rawData !== null && typeof rawData === 'object' && !Array.isArray(rawData)
        ? rawData as Record<string, unknown> // RPC error data is a record; guard its object shape before indexing.
        : {}
      const kind = data.kind === 'issue' ? 'issue' : 'setup'
      const kindLabel = kind === 'issue' ? 'issue command' : 'setup'
      const choice = await hooks.askTrust({
        repoId: typeof data.repo === 'string' ? data.repo : String(fields.repo),
        kind,
        script: typeof data.script === 'string' ? data.script : '',
        changed: data.changed === true
      })
      if (choice === 'cancel') return null
      if (choice === 'run') {
        if (typeof data.hash !== 'string' || data.hash.length === 0) {
          context.toast(
            `Could not run ${kindLabel} once`,
            `The daemon did not include a content hash for the shared ${kindLabel}, so one-time consent cannot be pinned. Retry creation so the daemon can report the current script hash.`
          )
          return null
        }
        if (kind === 'issue') {
          choices.trustIssueCommand = true
          choices.trustIssueCommandHash = data.hash
        } else {
          choices.trustSetup = true
          choices.trustSetupHash = data.hash
        }
      } else if (choice === 'skip') choices[kind === 'issue' ? 'issueCommand' : 'setup'] = 'skip'
      else {
        if (typeof data.hash !== 'string' || data.hash.length === 0) {
          context.toast(
            `Could not trust ${kindLabel}`,
            `The daemon did not include a content hash for the shared ${kindLabel}, so trust cannot be pinned to the displayed script. Retry creation so the daemon can report the current script hash.`
          )
          return null
        }
        try {
          await context.call('quirky.repo/trustHooks', { repo: String(fields.repo), kind, ...(typeof data.ref === 'string' ? { ref: data.ref } : {}) })
        } catch (trustError) {
          context.toast(`Could not trust ${kindLabel}`, messageOf(trustError))
          return null
        }
        if (kind === 'issue') {
          choices.trustIssueCommand = true
          choices.trustIssueCommandHash = data.hash
        } else {
          choices.trustSetup = true
          choices.trustSetupHash = data.hash
        }
      }
      attempt = { ...fields, ...choices }
    }
  }
}

/** Changes a workspace's metadata; true on success, else a toast says why. */
export async function setWorktree(
  context: UiPluginContext,
  worktreeId: string,
  patch: {
    status?: string
    pinned?: boolean
    unread?: boolean
    noParent?: boolean
    displayName?: string
    comment?: string
    parent?: string
  }
): Promise<boolean> {
  try {
    await context.call('quirky.worktree/set', { worktree: worktreeId, ...patch })
    return true
  } catch (error) {
    context.toast('Could not update workspace', messageOf(error))
    return false
  }
}

/** Changes only persisted visibility metadata; sleep first checks the exact selected subtree. */
export async function setWorkspaceSleeping(
  context: UiPluginContext,
  worktreeId: string,
  sleeping: boolean,
  withDescendants = false
): Promise<boolean> {
  const params = { worktree: worktreeId, ...(withDescendants ? { withDescendants: true } : {}) }
  try {
    if (sleeping) {
      const window = await currentWindowId(context)
      const selectedParams = { ...params, window }
      const preview = await context.call('quirky.worktree/sleepPreview', selectedParams) as {
        worktrees: Array<{ name: string; allowed: boolean; blockers: Array<{ detail: string }> }>
      }
      const blocked = preview.worktrees.filter((row) => !row.allowed)
      if (blocked.length > 0) {
        context.toast('Could not sleep workspace', blocked.map((row) => `${row.name}: ${row.blockers.map((blocker) => blocker.detail).join(' ')}`).join(' '))
        return false
      }
      await context.call('quirky.worktree/sleep', selectedParams)
    } else {
      await context.call('quirky.worktree/wake', params)
    }
    return true
  } catch (error) {
    context.toast(`Could not ${sleeping ? 'sleep' : 'wake'} workspace`, messageOf(error))
    return false
  }
}

/** Puts `text` on the clipboard; a refusal becomes a toast. */
export async function copyText(context: UiPluginContext, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch (error) {
    context.toast('Could not copy', messageOf(error))
  }
}

const CONFIRM_DELETE = 'setting:quirky.worktree/confirmDelete'

/** Whether deleting a workspace asks first; on unless the person turned it off (or the setting can't be read). */
export function confirmsDelete(context: UiPluginContext): boolean {
  try {
    return context.getSetting(CONFIRM_DELETE) !== false
  } catch {
    return true
  }
}

/** A branch a delete left behind because git can't show it merged, kept in a section notice. */
export type KeptBranch = { repoId: string; branch: string; head: string }

/**
 * Deletes a workspace the person has already been asked about (or opted out of being asked): the
 * call forces past uncommitted changes, which the dialog warned about. With `dontAskAgain` the
 * confirmation is switched off first. Returns the branch the delete kept, if any; a refusal
 * toasts "Failed to delete workspace" and returns null.
 */
export async function deleteWorkspace(
  context: UiPluginContext,
  worktree: Worktree,
  options: { withDescendants?: boolean; dontAskAgain?: boolean } = {}
): Promise<KeptBranch | null> {
  if (options.dontAskAgain) {
    try {
      await context.call('setting.set', { id: CONFIRM_DELETE, value: false })
      context.toast("We'll skip this confirmation next time. You can change this in Settings.", '')
    } catch (error) {
      context.toast('Could not change the setting', messageOf(error))
    }
  }
  try {
    const result = (await context.call('quirky.worktree/remove', {
      worktree: worktree.id,
      force: true,
      yes: true,
      ...(options.withDescendants ? { withDescendants: true } : {})
    })) as WorktreeRemoveResult
    return result.keptBranch ? { repoId: worktree.repoId, branch: result.keptBranch.name, head: result.keptBranch.head } : null
  } catch (error) {
    context.toast(`Failed to delete workspace ${worktree.name}`, messageOf(error))
    return null
  }
}

/** Deletes the branch a delete kept, if it still points where it did; true on success, else a toast says why. */
export async function deleteKeptBranch(context: UiPluginContext, kept: KeptBranch): Promise<boolean> {
  try {
    await context.call('quirky.worktree/deleteBranch', { repo: kept.repoId, branch: kept.branch, head: kept.head, yes: true })
    return true
  } catch (error) {
    context.toast('Could not delete branch', messageOf(error))
    return false
  }
}
