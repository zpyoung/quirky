import { isDeepStrictEqual } from 'node:util'
import type { AutomationCreateInput } from '../../shared/automations-types'
import type { Store } from '../persistence/loading-store/store'
import type { Repo } from '../../shared/repo-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { ImportFailure } from './import-failure'
import { ORCA_AUTOMATION_CREATION_KEY_PREFIX, type ImportPlan } from './plan'

/** The slice of the live `Store` the importer reads and writes; every write goes through a domain setter. */
export type ImportStore = Pick<
  Store,
  | 'addDeletedSshConfigAlias'
  | 'addRemovedSshTargetTombstone'
  | 'addSshTarget'
  | 'createAutomation'
  | 'createFolderWorkspace'
  | 'createProjectGroup'
  | 'createProjectHostSetup'
  | 'deleteAutomation'
  | 'deleteProjectGroup'
  | 'deleteProjectHostSetup'
  | 'flushOrThrow'
  | 'getAllWorkspaceLineage'
  | 'getAllWorktreeLineage'
  | 'getAllWorktreeMeta'
  | 'getDeletedSshConfigAliases'
  | 'getFolderWorkspaces'
  | 'getOnboarding'
  | 'getProjectGroups'
  | 'getProjectHostSetups'
  | 'getProjects'
  | 'getRemovedSshTargetTombstones'
  | 'getRepos'
  | 'getRetiredWorktreeNameRegistry'
  | 'getRetiredWorktreeNameRegistryForNamespace'
  | 'getSshTargetGenerationCounter'
  | 'getWorkspaceLineage'
  | 'removeWorkspaceLineage'
  | 'restoreRetiredWorktreeNameRegistry'
  | 'restoreRetiredWorktreeNameRegistryForNamespace'
  | 'setSshTargetGenerationCounter'
  | 'getSettings'
  | 'getSparsePresets'
  | 'getSshTargets'
  | 'getUI'
  | 'listAutomations'
  | 'mergeRetiredWorktreeNames'
  | 'mergeRetiredWorktreeNamesForNamespace'
  | 'addRepo'
  | 'removeDeletedSshConfigAlias'
  | 'removeFolderWorkspace'
  | 'removeProjectForHost'
  | 'removeRemovedSshTargetTombstone'
  | 'removeSparsePreset'
  | 'removeSshTarget'
  | 'removeWorktreeLineage'
  | 'removeWorktreeMeta'
  | 'saveSparsePreset'
  | 'setWorkspaceLineage'
  | 'setWorktreeLineage'
  | 'setWorktreeMeta'
  | 'updateFolderWorkspace'
  | 'updateOnboarding'
  | 'updateProjectGroup'
  | 'updateSettings'
  | 'updateUI'
>

export type ApplyOptions = {
  /** Quirky's own settings defaults; a key still at its default counts as unset. */
  defaultSettings: GlobalSettings
}

export type ApplyResult = {
  /** Source ids added, per source domain. */
  imported: Record<string, string[]>
  /** Source id to the Quirky id, for domains whose setters mint ids. */
  idMap: Record<string, Record<string, string>>
  /** Secret slots that were written into Quirky. */
  secretsImported: string[]
  /** Undoes every setter call this apply made; safe to call once, after a later step fails. */
  rollback: () => void
}

const FOLDER_WORKSPACE_STATE_KEYS = [
  'comment',
  'isArchived',
  'isUnread',
  'isPinned',
  'sortOrder',
  'manualOrder',
  'workspaceStatus',
  'lastActivityAt',
  'smartTier',
  'smartAt',
  'lastTerminalUseAt',
  'diffComments'
] as const

function pickDefined<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[]
): Partial<T> {
  const picked: Partial<T> = {}
  for (const key of keys) {
    if (source[key] !== undefined) {
      picked[key] = source[key]
    }
  }
  return picked
}

function pickPrevious<T extends object>(current: T, updates: Partial<T>): Partial<T> {
  const previous: Partial<T> = {}
  for (const key in updates) {
    previous[key] = current[key]
  }
  return previous
}

/**
 * Applies the plan through the store's domain setters, adding items and never replacing any.
 * On a failure every setter call made so far is undone in reverse order and a `WRITE_FAILED`
 * is thrown. Settings are filled in only where Quirky's value is still the default, and
 * linked accounts are merged by id, so a first import into a used profile keeps what it has.
 */
export function applyImportPlan(
  store: ImportStore,
  plan: ImportPlan,
  priorIdMap: Record<string, Record<string, string>>,
  options: ApplyOptions
): ApplyResult {
  const undo: (() => void)[] = []
  const imported: Record<string, string[]> = {}
  const idMap: Record<string, Record<string, string>> = {
    projectGroups: { ...priorIdMap.projectGroups },
    folderWorkspaces: { ...priorIdMap.folderWorkspaces }
  }
  const secretsImported: string[] = []
  const record = (domain: string, id: string): void => {
    imported[domain] = [...(imported[domain] ?? []), id]
  }
  const groupId = (sourceId: string | null | undefined): string | null =>
    sourceId ? (idMap.projectGroups[sourceId] ?? null) : null

  const rollback = (): void => {
    for (const step of undo.splice(0).toReversed()) {
      try {
        step()
      } catch {
        continue
      }
    }
    try {
      store.flushOrThrow()
    } catch {
      // the original failure is the one worth reporting
    }
  }

  try {
    applyGroups(store, plan, idMap, undo, record)
    applyRepos(store, plan, groupId, undo, record)
    applyFolderWorkspaces(store, plan, idMap, undo, record)
    applyProjectsAndSetups(store, plan, undo, record)
    applyWorktrees(store, plan, groupId, undo, record)
    applyScalarState(store, plan, options, secretsImported, undo, record)
    applySsh(store, plan, undo, record)
    applyAutomations(store, plan, undo, record)
    applyLineageAndNames(store, plan, idMap, undo, record)
    store.flushOrThrow()
  } catch (error) {
    rollback()
    throw new ImportFailure(
      'WRITE_FAILED',
      `Writing the imported items failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return { imported, idMap, secretsImported, rollback }
}

type Recorder = (domain: string, id: string) => void
type Undo = (() => void)[]

function applyGroups(
  store: ImportStore,
  plan: ImportPlan,
  idMap: Record<string, Record<string, string>>,
  undo: Undo,
  record: Recorder
): void {
  const pending = [...plan.groups]
  const sourceIds = new Set(plan.groups.map((group) => group.id))
  while (pending.length > 0) {
    const index = pending.findIndex(
      (group) =>
        !group.parentGroupId ||
        !sourceIds.has(group.parentGroupId) ||
        idMap.projectGroups[group.parentGroupId] !== undefined
    )
    const [group] = pending.splice(index === -1 ? 0 : index, 1)
    const created = store.createProjectGroup({
      name: group.name,
      parentPath: group.parentPath,
      connectionId: group.connectionId ?? null,
      parentGroupId: group.parentGroupId
        ? (idMap.projectGroups[group.parentGroupId] ?? null)
        : null,
      createdFrom: group.createdFrom
    })
    undo.push(() => store.deleteProjectGroup(created.id))
    store.updateProjectGroup(created.id, {
      isCollapsed: group.isCollapsed,
      tabOrder: group.tabOrder,
      color: group.color
    })
    idMap.projectGroups[group.id] = created.id
    record('projectGroups', group.id)
  }
}

function applyRepos(
  store: ImportStore,
  plan: ImportPlan,
  groupId: (sourceId: string | null | undefined) => string | null,
  undo: Undo,
  record: Recorder
): void {
  for (const source of plan.repos) {
    const repo: Repo = source.projectGroupId
      ? { ...source, projectGroupId: groupId(source.projectGroupId) }
      : source
    store.addRepo(repo)
    undo.push(() => store.removeProjectForHost(repo))
    record('repos', repo.id)
  }
}

function applyFolderWorkspaces(
  store: ImportStore,
  plan: ImportPlan,
  idMap: Record<string, Record<string, string>>,
  undo: Undo,
  record: Recorder
): void {
  for (const source of plan.folderWorkspaces) {
    const mappedGroup = idMap.projectGroups[source.projectGroupId]
    if (mappedGroup === undefined) {
      continue
    }
    const created: FolderWorkspace = store.createFolderWorkspace({
      projectGroupId: mappedGroup,
      name: source.name,
      folderPath: source.folderPath,
      connectionId: source.connectionId ?? null
    })
    undo.push(() => store.removeFolderWorkspace(created.id))
    store.updateFolderWorkspace(created.id, pickDefined(source, FOLDER_WORKSPACE_STATE_KEYS))
    idMap.folderWorkspaces[source.id] = created.id
    record('folderWorkspaces', source.id)
  }
}

function applyProjectsAndSetups(
  store: ImportStore,
  plan: ImportPlan,
  undo: Undo,
  record: Recorder
): void {
  const present = new Set(store.getProjects().map((project) => project.id))
  for (const project of plan.projects) {
    if (present.has(project.id)) {
      record('projects', project.id)
    }
  }
  for (const setup of plan.independentSetups) {
    const duplicate = store
      .getProjectHostSetups()
      .some((entry) => entry.projectId === setup.projectId && entry.hostId === setup.hostId)
    if (duplicate) {
      continue
    }
    const created = store.createProjectHostSetup({
      projectId: setup.projectId,
      hostId: setup.hostId,
      setupId: setup.id,
      path: setup.path,
      kind: setup.kind,
      displayName: setup.displayName,
      worktreeBasePath: setup.worktreeBasePath,
      gitUsername: setup.gitUsername,
      setupState: setup.setupState,
      setupMethod: setup.setupMethod === 'legacy-repo' ? undefined : setup.setupMethod
    })
    if (created) {
      undo.push(() =>
        store.deleteProjectHostSetup({ setupId: created.setup.id, hostId: created.setup.hostId })
      )
      record('projectHostSetups', setup.id)
    }
  }
}

function applyWorktrees(
  store: ImportStore,
  plan: ImportPlan,
  groupId: (sourceId: string | null | undefined) => string | null,
  undo: Undo,
  record: Recorder
): void {
  for (const { id, meta: source } of plan.worktreeMeta) {
    const meta = source.projectGroupId
      ? { ...source, projectGroupId: groupId(source.projectGroupId) }
      : source
    const target = hostWorktreeTarget({ id, hostId: meta.hostId ?? 'local' })
    store.setWorktreeMeta(target, meta)
    undo.push(() => store.removeWorktreeMeta(target))
    record('worktreeMeta', id)
  }
  for (const lineage of plan.worktreeLineage) {
    const owner = plan.worktreeMeta.find((entry) => entry.id === lineage.worktreeId)
    const target = hostWorktreeTarget({
      id: lineage.worktreeId,
      hostId: owner?.meta.hostId ?? 'local'
    })
    if (store.setWorktreeLineage(target, lineage)) {
      undo.push(() => store.removeWorktreeLineage(target))
      record('worktreeLineageById', lineage.worktreeId)
    }
  }
  for (const preset of plan.sparsePresets) {
    store.saveSparsePreset(preset)
    undo.push(() => store.removeSparsePreset(preset.repoId, preset.id))
    record('sparsePresetsByRepo', preset.id)
  }
}

function applyScalarState(
  store: ImportStore,
  plan: ImportPlan,
  options: ApplyOptions,
  secretsImported: string[],
  undo: Undo,
  record: Recorder
): void {
  const settingsBefore = store.getSettings()
  const updates: Partial<GlobalSettings> = {}
  if (plan.settings !== null) {
    for (const key of Object.keys(plan.settings) as (keyof GlobalSettings)[]) {
      if (
        key !== 'claudeManagedAccounts' &&
        key !== 'codexManagedAccounts' &&
        isDeepStrictEqual(settingsBefore[key], options.defaultSettings[key])
      ) {
        Object.assign(updates, { [key]: plan.settings[key] })
      }
    }
    record('settings', 'settings')
  }
  if (plan.claudeAccounts.length > 0) {
    updates.claudeManagedAccounts = [
      ...settingsBefore.claudeManagedAccounts,
      ...plan.claudeAccounts
    ]
  }
  if (plan.codexAccounts.length > 0) {
    updates.codexManagedAccounts = [...settingsBefore.codexManagedAccounts, ...plan.codexAccounts]
  }
  if (Object.keys(updates).length > 0) {
    const previous = pickPrevious(settingsBefore, updates)
    store.updateSettings(updates)
    undo.push(() => store.updateSettings(previous))
  }
  for (const account of plan.claudeAccounts) {
    record('settings.claudeManagedAccounts', account.id)
  }
  for (const account of plan.codexAccounts) {
    record('settings.codexManagedAccounts', account.id)
  }

  const uiBefore = store.getUI()
  if (plan.ui !== null) {
    const previous = pickPrevious(uiBefore, plan.ui)
    store.updateUI(plan.ui)
    undo.push(() => store.updateUI(previous))
    record('ui', 'ui')
  }
  const onboardingBefore = store.getOnboarding()
  if (plan.onboarding !== null) {
    const previous = pickPrevious(onboardingBefore, plan.onboarding)
    store.updateOnboarding(plan.onboarding)
    undo.push(() => store.updateOnboarding(previous))
    record('onboarding', 'onboarding')
  }

  const settingsNow = store.getSettings()
  const settingsSecrets: Partial<GlobalSettings> = {}
  if (plan.secrets.settings.opencodeSessionCookie && !settingsNow.opencodeSessionCookie) {
    settingsSecrets.opencodeSessionCookie = plan.secrets.settings.opencodeSessionCookie
  }
  if (plan.secrets.settings.httpProxyUrl && !settingsNow.httpProxyUrl) {
    settingsSecrets.httpProxyUrl = plan.secrets.settings.httpProxyUrl
  }
  if (Object.keys(settingsSecrets).length > 0) {
    const previous = pickPrevious(settingsNow, settingsSecrets)
    store.updateSettings(settingsSecrets)
    undo.push(() => store.updateSettings(previous))
  }
  if (plan.secrets.ui.browserKagiSessionLink && !store.getUI().browserKagiSessionLink) {
    store.updateUI(plan.secrets.ui)
    undo.push(() => store.updateUI({ browserKagiSessionLink: null }))
  }
  for (const slot of plan.secrets.slots) {
    secretsImported.push(slot)
  }
}

function applySsh(store: ImportStore, plan: ImportPlan, undo: Undo, record: Recorder): void {
  const counterBefore = store.getSshTargetGenerationCounter()
  if (plan.sshTargetGenerationCounter !== null && plan.sshTargetGenerationCounter > counterBefore) {
    store.setSshTargetGenerationCounter(plan.sshTargetGenerationCounter)
    undo.push(() => store.setSshTargetGenerationCounter(counterBefore))
  }
  for (const target of plan.sshTargets) {
    store.addSshTarget(target)
    undo.push(() => store.removeSshTarget(target.id))
    record('sshTargets', target.id)
  }
  for (const alias of plan.deletedSshConfigAliases) {
    store.addDeletedSshConfigAlias(alias)
    undo.push(() => store.removeDeletedSshConfigAlias(alias))
    record('deletedSshConfigAliases', alias)
  }
  for (const tombstone of plan.sshTombstones) {
    store.addRemovedSshTargetTombstone(tombstone)
    undo.push(() => store.removeRemovedSshTargetTombstone(tombstone.oldTargetId))
    record('removedSshTargetTombstones', tombstone.oldTargetId)
  }
}

function applyAutomations(
  store: ImportStore,
  plan: ImportPlan,
  undo: Undo,
  record: Recorder
): void {
  for (const source of plan.automations) {
    const input: AutomationCreateInput = {
      creationKey: `${ORCA_AUTOMATION_CREATION_KEY_PREFIX}${source.id}`,
      name: source.name,
      prompt: source.prompt,
      precheck: source.precheck,
      agentId: source.agentId,
      extraAgentArgs: source.extraAgentArgs,
      launchOverrides: source.launchOverrides,
      runContext: source.runContext,
      sourceContext: source.sourceContext,
      projectId: source.projectId,
      workspaceMode: source.workspaceMode,
      workspaceId: source.workspaceId,
      baseBranch: source.baseBranch,
      setupDecision: source.setupDecision,
      reuseSession: source.reuseSession,
      timezone: source.timezone,
      rrule: source.rrule,
      dtstart: source.dtstart,
      enabled: false,
      missedRunGraceMinutes: source.missedRunGraceMinutes
    }
    const created = store.createAutomation(input)
    undo.push(() => store.deleteAutomation(created.id))
    record('automations', source.id)
  }
}

function applyLineageAndNames(
  store: ImportStore,
  plan: ImportPlan,
  idMap: Record<string, Record<string, string>>,
  undo: Undo,
  record: Recorder
): void {
  for (const { repoId, names } of plan.retiredByRepo) {
    if (store.getRepos().some((repo) => repo.id === repoId)) {
      const before = store.getRetiredWorktreeNameRegistry(repoId)
      store.mergeRetiredWorktreeNames(repoId, names)
      undo.push(() => store.restoreRetiredWorktreeNameRegistry(repoId, before))
      record('retiredWorktreeNamesByRepo', repoId)
    }
  }
  for (const { key, names } of plan.retiredByNamespace) {
    const before = store.getRetiredWorktreeNameRegistryForNamespace(key)
    store.mergeRetiredWorktreeNamesForNamespace(key, names)
    undo.push(() => store.restoreRetiredWorktreeNameRegistryForNamespace(key, before))
    record('retiredWorktreeNamesByNamespace', key)
  }
  for (const lineage of plan.workspaceLineage) {
    const remapped = remapFolderKeys(lineage, idMap.folderWorkspaces)
    if (remapped !== null) {
      const before = store.getWorkspaceLineage(remapped.childWorkspaceKey)
      store.setWorkspaceLineage(remapped)
      undo.push(() =>
        before === undefined
          ? store.removeWorkspaceLineage(remapped)
          : void store.setWorkspaceLineage(before)
      )
      record('workspaceLineageByChildKey', lineage.childWorkspaceKey)
    }
  }
}

function remapFolderKeys<T extends { childWorkspaceKey: string; parentWorkspaceKey: string }>(
  lineage: T,
  folderIds: Record<string, string>
): T | null {
  const remap = (key: string): string | null => {
    if (!key.startsWith('folder:')) {
      return key
    }
    const mapped = folderIds[key.slice('folder:'.length)]
    return mapped === undefined ? null : `folder:${mapped}`
  }
  const child = remap(lineage.childWorkspaceKey)
  const parent = remap(lineage.parentWorkspaceKey)
  if (child === null || parent === null) {
    return null
  }
  const childKey: T['childWorkspaceKey'] = child
  const parentKey: T['parentWorkspaceKey'] = parent
  return { ...lineage, childWorkspaceKey: childKey, parentWorkspaceKey: parentKey }
}
