import { isAbsolute, join, sep } from 'node:path'
import type { Automation } from '../../shared/automations-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ClaudeManagedAccount, CodexManagedAccount } from '../../shared/managed-account-types'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { Project, ProjectHostSetup } from '../../shared/project-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import type { RemovedSshTargetTombstone, SshTarget } from '../../shared/ssh-types'
import type { SparsePreset } from '../../shared/worktree/create-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { QUIRKY_WORKSPACE_DIR_SEGMENTS } from './constants'
import type { SourceState } from './source-state'

export const ORCA_AUTOMATION_CREATION_KEY_PREFIX = 'import-from-orca:'

/** Secret-bearing fields in the stored state, addressed the way the persistence layer names them. */
export const SECRET_SLOTS = [
  'settings.opencodeSessionCookie',
  'settings.httpProxyUrl',
  'ui.browserKagiSessionLink'
] as const
export type SecretSlot = (typeof SECRET_SLOTS)[number]

const HANDLED_DOMAINS = new Set([
  'repos',
  'projects',
  'projectHostSetups',
  'folderWorkspaces',
  'projectGroups',
  'worktreeMeta',
  'worktreeMetaByIdentity',
  'worktreeIdentityAliases',
  'worktreeLineageById',
  'retiredWorktreeNamesByRepo',
  'settings',
  'automations',
  'sshTargets',
  'sshTargetGenerationCounter',
  'deletedSshConfigAliases',
  'removedSshTargetTombstones',
  'ui',
  'onboarding',
  'sparsePresetsByRepo',
  'folderWorkspaceDiffComments',
  'retiredWorktreeNamesByNamespace',
  'workspaceLineageByChildKey'
])

const NOT_COPIED_DOMAINS = new Set([
  'schemaVersion',
  'automationRuns',
  'sshRemotePtyLeases',
  'sshPtyConsumerRecoveries',
  'remoteLayoutSnapshots',
  'legacyPaneKeyAliasEntries',
  'githubCache',
  'nativeChatUpgradeTipAudience',
  'migrationUnsupportedPtyEntries',
  'featureInteractionTelemetryBuckets',
  'codexResetCreditAttemptLedger',
  'mobileClientTabSelectionsByDeviceId'
])

// Saved workspace sessions (live tabs, panes, scrollback) stay with the app that made them.
const NOT_COPIED_DOMAIN_PATTERN = /^(orcadMigration|quirkydMigration|workspaceSession)/

const REMOVED_KEY = /(wsl|bitbucket|gitea|azure)/i
const REMOVED_VALUE = /^(wsl|bitbucket|gitea|azure)\b/i
const KIND_KEYS = new Set(['kind', 'provider', 'hostId', 'executionHostId', 'hostKind', 'source'])
const SETTINGS_OVERRIDDEN_KEYS = new Set([
  'workspaceDir',
  'opencodeSessionCookie',
  'httpProxyUrl',
  'opencodeGoApiKey'
])

const ACCOUNT_ROOT_SEGMENTS = ['claude-accounts', 'codex-accounts', 'claude-profiles']

/** What an import would add, with every source id still unmapped to a Quirky id. */
export type ImportPlan = {
  repos: Repo[]
  projects: Project[]
  independentSetups: ProjectHostSetup[]
  groups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  worktreeMeta: { id: string; meta: WorktreeMeta }[]
  worktreeLineage: WorktreeLineage[]
  workspaceLineage: WorkspaceLineage[]
  retiredByRepo: { repoId: string; names: string[] }[]
  retiredByNamespace: { key: string; names: string[] }[]
  sparsePresets: SparsePreset[]
  sshTargets: SshTarget[]
  deletedSshConfigAliases: string[]
  sshTombstones: RemovedSshTargetTombstone[]
  sshTargetGenerationCounter: number | null
  automations: Automation[]
  settings: Partial<GlobalSettings> | null
  claudeAccounts: ClaudeManagedAccount[]
  codexAccounts: CodexManagedAccount[]
  ui: Partial<PersistedUIState> | null
  onboarding: Partial<OnboardingState> | null
  secrets: { settings: Partial<GlobalSettings>; ui: Partial<PersistedUIState>; slots: SecretSlot[] }
  notImported: string[]
  normalizedAway: Record<string, number>
}

export type PlanInput = {
  source: SourceState
  /** Ids already brought over or already present in Quirky, per domain. */
  known: (domain: string) => ReadonlySet<string>
  /** Decrypted secret values, by slot; absent slots were skipped. */
  plaintextSecrets: ReadonlyMap<SecretSlot, string>
  userDataPath: string
  homeDir: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const isRepo = (value: unknown): value is Repo =>
  isRecord(value) && typeof value.id === 'string' && typeof value.path === 'string'
const isProject = (value: unknown): value is Project =>
  isRecord(value) && typeof value.id === 'string' && Array.isArray(value.sourceRepoIds)
const isSetup = (value: unknown): value is ProjectHostSetup =>
  isRecord(value) && typeof value.id === 'string' && typeof value.projectId === 'string'
const isGroup = (value: unknown): value is ProjectGroup =>
  isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
const isFolderWorkspace = (value: unknown): value is FolderWorkspace =>
  isRecord(value) && typeof value.id === 'string' && typeof value.projectGroupId === 'string'
const isLineage = (value: unknown): value is WorktreeLineage =>
  isRecord(value) && typeof value.worktreeId === 'string'
const isWorkspaceLineage = (value: unknown): value is WorkspaceLineage =>
  isRecord(value) && typeof value.childWorkspaceKey === 'string'
const isSparsePreset = (value: unknown): value is SparsePreset =>
  isRecord(value) && typeof value.id === 'string' && typeof value.repoId === 'string'
const isSshTarget = (value: unknown): value is SshTarget =>
  isRecord(value) && typeof value.id === 'string' && typeof value.host === 'string'
const isTombstone = (value: unknown): value is RemovedSshTargetTombstone =>
  isRecord(value) && typeof value.oldTargetId === 'string'
const isAutomation = (value: unknown): value is Automation =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  typeof value.prompt === 'string' &&
  typeof value.projectId === 'string'
const isClaudeAccount = (value: unknown): value is ClaudeManagedAccount =>
  isRecord(value) && typeof value.id === 'string' && typeof value.managedAuthPath === 'string'
const isCodexAccount = (value: unknown): value is CodexManagedAccount =>
  isRecord(value) && typeof value.id === 'string' && typeof value.managedHomePath === 'string'
const isMeta = (value: unknown): value is WorktreeMeta => isRecord(value)
const isSettings = (value: unknown): value is Partial<GlobalSettings> => isRecord(value)
const isUi = (value: unknown): value is Partial<PersistedUIState> => isRecord(value)
const isOnboarding = (value: unknown): value is Partial<OnboardingState> => isRecord(value)

function list<T>(value: unknown, guard: (entry: unknown) => entry is T): T[] {
  return Array.isArray(value) ? value.filter(guard) : []
}

function entriesOf<T>(value: unknown, guard: (entry: unknown) => entry is T): [string, T][] {
  if (!isRecord(value)) {
    return []
  }
  return Object.entries(value).flatMap(([key, entry]) => (guard(entry) ? [[key, entry]] : []))
}

/** True when an item points at a provider or host kind Quirky no longer has. */
export function namesRemovedProvider(item: Record<string, unknown>): boolean {
  return Object.entries(item).some(([key, value]) => {
    if (REMOVED_KEY.test(key) && value !== null && value !== undefined && value !== false) {
      return value !== ''
    }
    return KIND_KEYS.has(key) && typeof value === 'string' && REMOVED_VALUE.test(value)
  })
}

/** Maps a managed account path under Orca Dev's data into Quirky's userData; null when it points elsewhere. */
export function rewriteManagedPath(path: string, userDataPath: string): string | null {
  const parts = path.split(sep).filter((part) => part.length > 0)
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (ACCOUNT_ROOT_SEGMENTS.includes(parts[index])) {
      return join(userDataPath, ...parts.slice(index))
    }
  }
  return null
}

/** The `~/quirky/workspaces` directory new worktrees land in. */
export function quirkyWorkspaceDir(homeDir: string): string {
  return join(homeDir, ...QUIRKY_WORKSPACE_DIR_SEGMENTS)
}

/** Lists the source domains this import version neither copies nor deliberately skips. */
export function unlistedDomains(source: SourceState): string[] {
  return Object.keys(source)
    .filter(
      (domain) =>
        !HANDLED_DOMAINS.has(domain) &&
        !NOT_COPIED_DOMAINS.has(domain) &&
        !NOT_COPIED_DOMAIN_PATTERN.test(domain)
    )
    .sort()
}

/** The v10 secret values present in the source, keyed by slot. Ciphertext only. */
export function collectSecretCiphertexts(source: SourceState): Map<SecretSlot, string> {
  const found = new Map<SecretSlot, string>()
  const settings = isRecord(source.settings) ? source.settings : {}
  const ui = isRecord(source.ui) ? source.ui : {}
  const candidates: [SecretSlot, unknown][] = [
    ['settings.opencodeSessionCookie', settings.opencodeSessionCookie],
    ['settings.httpProxyUrl', settings.httpProxyUrl],
    ['ui.browserKagiSessionLink', ui.browserKagiSessionLink]
  ]
  for (const [slot, value] of candidates) {
    if (typeof value === 'string' && value.length > 0) {
      found.set(slot, value)
    }
  }
  return found
}

function stripRemovedKeys(
  record: Record<string, unknown>,
  skip: ReadonlySet<string>,
  normalizedAway: Record<string, number>,
  domain: string
): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (skip.has(key)) {
      continue
    }
    if (REMOVED_KEY.test(key)) {
      normalizedAway[domain] = (normalizedAway[domain] ?? 0) + 1
      continue
    }
    kept[key] = value
  }
  return kept
}

function dropRemoved<T extends Record<string, unknown>>(
  items: T[],
  domain: string,
  normalizedAway: Record<string, number>,
  idOf: (item: T) => string
): { kept: T[]; droppedIds: string[] } {
  const kept: T[] = []
  const droppedIds: string[] = []
  for (const item of items) {
    if (namesRemovedProvider(item)) {
      droppedIds.push(idOf(item))
    } else {
      kept.push(item)
    }
  }
  if (droppedIds.length > 0) {
    normalizedAway[domain] = (normalizedAway[domain] ?? 0) + droppedIds.length
  }
  return { kept, droppedIds }
}

function newOnly<T>(items: T[], idOf: (item: T) => string, known: ReadonlySet<string>): T[] {
  return items.filter((item) => !known.has(idOf(item)))
}

function planAccounts<T extends Record<string, unknown> & { id: string }>(
  accounts: T[],
  pathKey: 'managedAuthPath' | 'managedHomePath',
  domain: string,
  input: PlanInput,
  normalizedAway: Record<string, number>
): T[] {
  const result: T[] = []
  for (const account of accounts) {
    const stripped = { ...account }
    Reflect.deleteProperty(stripped, 'wslLinuxAuthPath')
    Reflect.deleteProperty(stripped, 'wslLinuxHomePath')
    if (namesRemovedProvider(stripped)) {
      normalizedAway[domain] = (normalizedAway[domain] ?? 0) + 1
      continue
    }
    const original = stripped[pathKey]
    const rewritten =
      typeof original === 'string' && isAbsolute(original)
        ? rewriteManagedPath(original, input.userDataPath)
        : null
    if (rewritten === null) {
      normalizedAway[domain] = (normalizedAway[domain] ?? 0) + 1
      continue
    }
    result.push({ ...stripped, [pathKey]: rewritten })
  }
  return result
}

/** Transforms the source state into the items Quirky does not have yet, per the field mapping table. */
export function buildImportPlan(input: PlanInput): ImportPlan {
  const { source, known } = input
  const normalizedAway: Record<string, number> = {}

  const repoResult = dropRemoved(list(source.repos, isRepo), 'repos', normalizedAway, (r) => r.id)
  const droppedRepoIds = new Set(repoResult.droppedIds)
  const repos = newOnly(repoResult.kept, (repo) => repo.id, known('repos'))
  const inDroppedRepo = (worktreeId: string): boolean =>
    [...droppedRepoIds].some((repoId) => worktreeId.startsWith(`${repoId}::`))

  const projects = list(source.projects, isProject).filter(
    (project) =>
      !namesRemovedProvider(project) &&
      !project.sourceRepoIds.every((repoId) => droppedRepoIds.has(repoId))
  )
  const repoBackedIds = new Set(list(source.repos, isRepo).map((repo) => repo.id))
  const setupResult = dropRemoved(
    list(source.projectHostSetups, isSetup).filter((setup) => !repoBackedIds.has(setup.repoId)),
    'projectHostSetups',
    normalizedAway,
    (s) => s.id
  )
  const groupResult = dropRemoved(
    list(source.projectGroups, isGroup),
    'projectGroups',
    normalizedAway,
    (g) => g.id
  )
  const folderResult = dropRemoved(
    list(source.folderWorkspaces, isFolderWorkspace),
    'folderWorkspaces',
    normalizedAway,
    (f) => f.id
  )
  const diffComments = isRecord(source.folderWorkspaceDiffComments)
    ? source.folderWorkspaceDiffComments
    : {}
  const folderWorkspaces = newOnly(
    folderResult.kept,
    (folder) => folder.id,
    known('folderWorkspaces')
  ).map((folder) => {
    const comments = diffComments[folder.id]
    return Array.isArray(comments) ? { ...folder, diffComments: comments } : folder
  })

  const metaKnown = known('worktreeMeta')
  const metaDropped: string[] = []
  const worktreeMeta = entriesOf(source.worktreeMeta, isMeta).flatMap(([id, meta]) => {
    if (metaKnown.has(id)) {
      return []
    }
    if (inDroppedRepo(id) || namesRemovedProvider(meta)) {
      metaDropped.push(id)
      return []
    }
    return [{ id, meta }]
  })
  if (metaDropped.length > 0) {
    normalizedAway.worktreeMeta = metaDropped.length
  }
  const lineageKnown = known('worktreeLineageById')
  const worktreeLineage = entriesOf(source.worktreeLineageById, isLineage)
    .filter(([id]) => !lineageKnown.has(id) && !inDroppedRepo(id))
    .map(([, lineage]) => lineage)
  const workspaceLineageKnown = known('workspaceLineageByChildKey')
  const workspaceLineage = entriesOf(source.workspaceLineageByChildKey, isWorkspaceLineage)
    .filter(([key]) => !workspaceLineageKnown.has(key))
    .map(([, lineage]) => lineage)

  const registryNames = (value: unknown): string[] =>
    isRecord(value) && Array.isArray(value.names)
      ? value.names.filter((name): name is string => typeof name === 'string')
      : []
  const retiredRepoKnown = known('retiredWorktreeNamesByRepo')
  const retiredByRepo = Object.entries(
    isRecord(source.retiredWorktreeNamesByRepo) ? source.retiredWorktreeNamesByRepo : {}
  )
    .filter(([repoId]) => !retiredRepoKnown.has(repoId) && !droppedRepoIds.has(repoId))
    .map(([repoId, registry]) => ({ repoId, names: registryNames(registry) }))
    .filter((entry) => entry.names.length > 0)
  const retiredNamespaceKnown = known('retiredWorktreeNamesByNamespace')
  const retiredByNamespace = Object.entries(
    isRecord(source.retiredWorktreeNamesByNamespace) ? source.retiredWorktreeNamesByNamespace : {}
  )
    .filter(([key]) => !retiredNamespaceKnown.has(key) && !REMOVED_VALUE.test(key))
    .map(([key, registry]) => ({ key, names: registryNames(registry) }))
    .filter((entry) => entry.names.length > 0)

  const presetKnown = known('sparsePresetsByRepo')
  const sparsePresets = Object.values(
    isRecord(source.sparsePresetsByRepo) ? source.sparsePresetsByRepo : {}
  )
    .flatMap((presets) => list(presets, isSparsePreset))
    .filter((preset) => !presetKnown.has(preset.id) && !droppedRepoIds.has(preset.repoId))

  const sshResult = dropRemoved(
    list(source.sshTargets, isSshTarget),
    'sshTargets',
    normalizedAway,
    (t) => t.id
  )
  const sshTargets = newOnly(sshResult.kept, (target) => target.id, known('sshTargets'))
  const aliasKnown = known('deletedSshConfigAliases')
  const deletedSshConfigAliases = (
    Array.isArray(source.deletedSshConfigAliases) ? source.deletedSshConfigAliases : []
  ).filter((alias): alias is string => typeof alias === 'string' && !aliasKnown.has(alias))
  const tombstoneKnown = known('removedSshTargetTombstones')
  const sshTombstones = list(source.removedSshTargetTombstones, isTombstone).filter(
    (tombstone) => !tombstoneKnown.has(tombstone.oldTargetId)
  )

  const sourceCounter = source.sshTargetGenerationCounter
  const sshTargetGenerationCounter =
    typeof sourceCounter === 'number' && Number.isInteger(sourceCounter) && sourceCounter > 0
      ? sourceCounter
      : null

  const automationResult = dropRemoved(
    list(source.automations, isAutomation).filter(
      (automation) => !droppedRepoIds.has(automation.projectId)
    ),
    'automations',
    normalizedAway,
    (a) => a.id
  )
  const automations = newOnly(automationResult.kept, (a) => a.id, known('automations'))

  const settingsSource = isSettings(source.settings) ? source.settings : {}
  const settingsKnown = known('settings').has('settings')
  const secretSettings: Partial<GlobalSettings> = {}
  const secretUi: Partial<PersistedUIState> = {}
  const slots: SecretSlot[] = []
  const cookie = input.plaintextSecrets.get('settings.opencodeSessionCookie')
  if (cookie !== undefined) {
    secretSettings.opencodeSessionCookie = cookie
    slots.push('settings.opencodeSessionCookie')
  }
  const proxy = input.plaintextSecrets.get('settings.httpProxyUrl')
  if (proxy !== undefined) {
    secretSettings.httpProxyUrl = proxy
    slots.push('settings.httpProxyUrl')
  }
  const kagi = input.plaintextSecrets.get('ui.browserKagiSessionLink')
  if (kagi !== undefined) {
    secretUi.browserKagiSessionLink = kagi
    slots.push('ui.browserKagiSessionLink')
  }

  const claudeAccounts = newOnly(
    planAccounts(
      list(settingsSource.claudeManagedAccounts, isClaudeAccount),
      'managedAuthPath',
      'settings.claudeManagedAccounts',
      input,
      normalizedAway
    ),
    (account) => account.id,
    known('settings.claudeManagedAccounts')
  )
  const codexAccounts = newOnly(
    planAccounts(
      list(settingsSource.codexManagedAccounts, isCodexAccount),
      'managedHomePath',
      'settings.codexManagedAccounts',
      input,
      normalizedAway
    ),
    (account) => account.id,
    known('settings.codexManagedAccounts')
  )

  let settings: Partial<GlobalSettings> | null = null
  if (!settingsKnown && isRecord(source.settings)) {
    const copied = stripRemovedKeys(
      settingsSource,
      new Set([...SETTINGS_OVERRIDDEN_KEYS, 'claudeManagedAccounts', 'codexManagedAccounts']),
      normalizedAway,
      'settings'
    )
    const withAccounts = {
      ...copied,
      workspaceDir: quirkyWorkspaceDir(input.homeDir),
      claudeManagedAccounts: claudeAccounts,
      codexManagedAccounts: codexAccounts
    }
    settings = isSettings(withAccounts) ? withAccounts : null
  }

  const uiKnown = known('ui').has('ui')
  const uiSource = isUi(source.ui) ? source.ui : null
  const ui =
    !uiKnown && uiSource
      ? stripRemovedKeys(uiSource, new Set(['browserKagiSessionLink']), normalizedAway, 'ui')
      : null
  const onboardingKnown = known('onboarding').has('onboarding')
  const onboarding =
    !onboardingKnown && isOnboarding(source.onboarding)
      ? stripRemovedKeys(source.onboarding, new Set(), normalizedAway, 'onboarding')
      : null

  return {
    repos,
    projects,
    independentSetups: newOnly(setupResult.kept, (setup) => setup.id, known('projectHostSetups')),
    groups: newOnly(groupResult.kept, (group) => group.id, known('projectGroups')),
    folderWorkspaces,
    worktreeMeta,
    worktreeLineage,
    workspaceLineage,
    retiredByRepo,
    retiredByNamespace,
    sparsePresets,
    sshTargets,
    deletedSshConfigAliases,
    sshTombstones,
    sshTargetGenerationCounter,
    automations,
    settings,
    claudeAccounts,
    codexAccounts,
    ui: ui !== null && isUi(ui) ? ui : null,
    onboarding: onboarding !== null && isOnboarding(onboarding) ? onboarding : null,
    secrets: { settings: secretSettings, ui: secretUi, slots },
    notImported: unlistedDomains(source),
    normalizedAway
  }
}
