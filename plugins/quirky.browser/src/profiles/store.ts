import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { validateValue, type Schema } from '@quirky/protocol'
import { fault } from '../runtime/errors'

export type BrowserProfile = {
  id: string
  label: string
  scope: 'default' | 'isolated' | 'imported'
  source?: { browserFamily: string; profileName?: string; importedAt: number }
}
export type BrowserPage = {
  browserPageId: string
  worktreeId: string | null
  profileId: string
  index: number
  active: boolean
  url: string
  title: string
  loadError: null | { code: string; description: string; validatedUrl: string }
}
export type BrowserState = { profiles: BrowserProfile[]; pages: BrowserPage[] }
export const NO_NATIVE_PANE_MARKER = '.no-native-pane'

const PROFILE_SCHEMA: Schema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    scope: { type: 'string', enum: ['default', 'isolated', 'imported'] },
    source: {
      type: 'object',
      properties: {
        browserFamily: { type: 'string' },
        profileName: { type: 'string' },
        importedAt: { type: 'number' }
      },
      required: ['browserFamily', 'importedAt'],
      additionalProperties: false
    }
  },
  required: ['id', 'label', 'scope'],
  additionalProperties: false
}

const LOAD_ERROR_SCHEMA: Schema = {
  type: 'object',
  properties: { code: { type: 'string' }, description: { type: 'string' }, validatedUrl: { type: 'string' } },
  required: ['code', 'description', 'validatedUrl'],
  additionalProperties: false
}

const PAGE_SCHEMA: Schema = {
  type: 'object',
  properties: {
    browserPageId: { type: 'string' },
    worktreeId: {},
    profileId: { type: 'string' },
    index: { type: 'integer' },
    active: { type: 'boolean' },
    url: { type: 'string' },
    title: { type: 'string' },
    loadError: {}
  },
  required: ['browserPageId', 'worktreeId', 'profileId', 'index', 'active', 'url', 'title', 'loadError'],
  additionalProperties: false
}

const STATE_SCHEMA: Schema = {
  type: 'object',
  properties: {
    profiles: { type: 'array', items: PROFILE_SCHEMA },
    pages: { type: 'array', items: PAGE_SCHEMA }
  },
  required: ['profiles', 'pages'],
  additionalProperties: false
}

export function isValidProfileId(id: string): boolean {
  return id === 'default' || /^profile_[0-9a-f]{32}$/.test(id)
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path))
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

export type BrowserStoreRecovery = {
  readonly quarantinedPath: string
  readonly recoveredProfileIds: readonly string[]
}

type FileIdentity = Pick<Stats, 'dev' | 'ino'>
type RecoveryHooks = {
  afterScan?: () => void
  beforeIdentityCheck?: () => void
  beforeRename?: () => void
  afterQuarantine?: () => void
}
type ScannedProfileChild = { name: string; identity: FileIdentity; adopted: boolean }
type RecoveryScan = {
  profilesRoot: string
  rootIdentity?: FileIdentity
  children: ScannedProfileChild[]
  adoptedChildren: ScannedProfileChild[]
  profiles: BrowserProfile[]
}
type TemporaryFile = { path: string; identity: FileIdentity }
type QuarantineResult =
  | { outcome: 'quarantined'; path: string }
  | { outcome: 'changed' }
  | { outcome: 'moved-unexpected'; path: string }
  | { outcome: 'occupied' }
  | { outcome: 'failed' }
type DecodedState = { state: BrowserState } | { error: string }

let recoveryHooks: RecoveryHooks | null = null

/** Test-only hook for exercising browser metadata recovery race conditions. */
export function setBrowserStoreRecoveryHooksForTests(hooks: RecoveryHooks | null): void {
  recoveryHooks = hooks
}

function sameIdentity(info: Stats, identity: FileIdentity): boolean {
  return info.dev === identity.dev && info.ino === identity.ino
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function decodeState(contents: string): DecodedState {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents) as unknown
  } catch {
    return { error: 'persisted browser metadata is unreadable' }
  }
  const failure = validateValue(STATE_SCHEMA, parsed, 'browser metadata')
  if (failure) return { error: 'persisted browser metadata has an invalid schema' }
  const state = parsed as BrowserState
  if (state.profiles.some((profile) => !isValidProfileId(profile.id)) || state.pages.some((page) => !isValidProfileId(page.profileId))) {
    return { error: 'persisted browser metadata contains an unsafe profile identifier' }
  }
  if (state.pages.some((page) =>
    page.worktreeId !== null && typeof page.worktreeId !== 'string' ||
    page.loadError !== null && validateValue(LOAD_ERROR_SCHEMA, page.loadError, 'page load error')
  )) {
    return { error: 'persisted browser metadata contains invalid page metadata' }
  }
  return { state }
}

function unlinkTemporaryFile(temporary: TemporaryFile): void {
  try {
    const info = lstatSync(temporary.path)
    if (info.isFile() && !info.isSymbolicLink() && sameIdentity(info, temporary.identity)) unlinkSync(temporary.path)
  } catch {
    // Cleanup must not remove an entry that replaced our temporary file.
  }
}

function guardedQuarantine(path: string, identity: FileIdentity): QuarantineResult {
  const candidates = new Set<string>()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let candidate: string
    do {
      candidate = `${path}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`
    } while (candidates.has(candidate))
    candidates.add(candidate)

    try {
      lstatSync(candidate)
      continue
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) continue
    }

    recoveryHooks?.beforeIdentityCheck?.()
    let current: Stats
    try {
      current = lstatSync(path)
    } catch {
      return { outcome: 'changed' }
    }
    if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, identity)) return { outcome: 'changed' }

    recoveryHooks?.beforeRename?.()
    try {
      renameSync(path, candidate)
    } catch {
      return { outcome: 'failed' }
    }

    try {
      const moved = lstatSync(candidate)
      if (moved.isFile() && !moved.isSymbolicLink() && sameIdentity(moved, identity)) {
        return { outcome: 'quarantined', path: candidate }
      }
    } catch {
      // Missing or inaccessible destination is still an unexpected move.
    }
    return { outcome: 'moved-unexpected', path: candidate }
  }
  return { outcome: 'occupied' }
}

export class BrowserStore {
  private readonly canonicalDataDir: string
  private readonly statePath: string
  private state: BrowserState
  readonly recovery: BrowserStoreRecovery | null

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const dataDirectoryInfo = lstatSync(dataDir)
    if (dataDirectoryInfo.isSymbolicLink() || !dataDirectoryInfo.isDirectory()) {
      throw fault('invalid_argument', 'browser data directory is not a safe directory')
    }
    this.canonicalDataDir = realpathSync(dataDir)
    this.statePath = join(this.canonicalDataDir, 'browser-state.json')
    const loaded = this.readState()
    this.state = loaded.state
    this.recovery = loaded.recovery
    chmodSync(dataDir, 0o700)
    if (!this.state.profiles.some((profile) => profile.id === 'default')) {
      this.state.profiles.unshift({ id: 'default', label: 'Default', scope: 'default' })
      this.persist()
    }
  }

  private readState(): { state: BrowserState; recovery: BrowserStoreRecovery | null } {
    if (!existsSync(this.statePath)) return { state: { profiles: [], pages: [] }, recovery: null }

    let initialInfo: Stats
    try {
      initialInfo = lstatSync(this.statePath)
    } catch {
      throw fault('browser_error', 'persisted browser metadata is unreadable')
    }
    if (initialInfo.isSymbolicLink() || !initialInfo.isFile()) {
      let contents: string
      try {
        contents = readFileSync(this.statePath, 'utf8')
      } catch {
        throw fault('browser_error', 'persisted browser metadata is unreadable')
      }
      const decoded = decodeState(contents)
      if ('error' in decoded) throw fault('browser_error', decoded.error)
      return { state: decoded.state, recovery: null }
    }

    let descriptor: number | undefined
    let identity: FileIdentity
    let contents: string
    try {
      descriptor = openSync(this.statePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const descriptorInfo = fstatSync(descriptor)
      if (!descriptorInfo.isFile()) throw new Error('browser metadata is not a regular file')
      identity = { dev: descriptorInfo.dev, ino: descriptorInfo.ino }
      contents = readFileSync(descriptor, 'utf8')
      closeSync(descriptor)
      descriptor = undefined
    } catch {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
        } catch {
          // Preserve the unreadable-store error.
        }
      }
      throw fault('browser_error', 'persisted browser metadata is unreadable')
    }

    const decoded = decodeState(contents)
    if ('state' in decoded) return { state: decoded.state, recovery: null }
    return this.recoverCorruptState(identity)
  }

  private scanRecoveryProfiles(): RecoveryScan {
    try {
      if (realpathSync(this.dataDir) !== this.canonicalDataDir) {
        throw new Error('browser data directory changed during recovery')
      }
    } catch {
      throw fault('invalid_argument', 'profile storage root is not a safe directory')
    }

    const profilesRoot = join(this.canonicalDataDir, 'profiles')
    let rootInfo: Stats | undefined
    try {
      rootInfo = lstatIfPresent(profilesRoot)
    } catch {
      throw fault('invalid_argument', 'profile storage root is not a safe directory')
    }
    if (rootInfo && (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())) {
      throw fault('invalid_argument', 'profile storage root is not a safe directory')
    }

    const children: ScannedProfileChild[] = []
    if (rootInfo) {
      let names: string[]
      try {
        names = readdirSync(profilesRoot)
      } catch {
        throw fault('invalid_argument', 'profile storage root is not a safe directory')
      }
      for (const name of names) {
        let info: Stats
        try {
          info = lstatSync(join(profilesRoot, name))
        } catch {
          throw fault('invalid_argument', 'profile storage root is not a safe directory')
        }
        const adopted = name !== 'default' && isValidProfileId(name) && info.isDirectory() && !info.isSymbolicLink()
        children.push({ name, identity: { dev: info.dev, ino: info.ino }, adopted })
      }
    }

    const adoptedChildren = children.filter((child) => child.adopted).sort((a, b) => a.name.localeCompare(b.name))
    const shortLabelCounts = new Map<string, number>()
    for (const child of adoptedChildren) {
      const shortLabel = child.name.slice('profile_'.length, 'profile_'.length + 8)
      shortLabelCounts.set(shortLabel, (shortLabelCounts.get(shortLabel) ?? 0) + 1)
    }
    const profiles = adoptedChildren.map((child) => {
      const suffix = child.name.slice('profile_'.length)
      const shortSuffix = suffix.slice(0, 8)
      const labelSuffix = shortLabelCounts.get(shortSuffix) === 1 ? shortSuffix : suffix
      return { id: child.name, label: `Recovered profile ${labelSuffix}`, scope: 'isolated' as const }
    })
    return {
      profilesRoot,
      ...(rootInfo ? { rootIdentity: { dev: rootInfo.dev, ino: rootInfo.ino } } : {}),
      children,
      adoptedChildren,
      profiles
    }
  }

  private revalidateRecoveryScan(scan: RecoveryScan): void {
    try {
      if (realpathSync(this.dataDir) !== this.canonicalDataDir) throw new Error('browser data directory changed during recovery')
      const currentRoot = lstatIfPresent(scan.profilesRoot)
      if (scan.rootIdentity) {
        if (!currentRoot || currentRoot.isSymbolicLink() || !currentRoot.isDirectory() || !sameIdentity(currentRoot, scan.rootIdentity)) {
          throw new Error('profile storage root changed during recovery')
        }
      } else if (currentRoot) {
        throw new Error('profile storage root changed during recovery')
      }
      for (const child of scan.adoptedChildren) {
        const current = lstatIfPresent(join(scan.profilesRoot, child.name))
        if (!current || current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(current, child.identity)) {
          throw new Error('adopted profile directory changed during recovery')
        }
      }
    } catch {
      throw fault('invalid_argument', 'profile storage root is not a safe directory')
    }
  }

  private writeRecoveryTemporary(state: BrowserState): TemporaryFile {
    const path = join(this.canonicalDataDir, `.browser-state.json.${randomUUID()}.tmp`)
    let descriptor: number | undefined
    let identity: FileIdentity | undefined
    try {
      descriptor = openSync(path, 'wx', 0o600)
      const info = fstatSync(descriptor)
      identity = { dev: info.dev, ino: info.ino }
      writeFileSync(descriptor, `${JSON.stringify(state)}\n`)
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      return { path, identity }
    } catch {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
        } catch {
          // Preserve the save error.
        }
      }
      if (identity) unlinkTemporaryFile({ path, identity })
      throw fault('browser_error', 'browser metadata could not be saved')
    }
  }

  private recoverCorruptState(identity: FileIdentity): { state: BrowserState; recovery: BrowserStoreRecovery } {
    const scan = this.scanRecoveryProfiles()
    recoveryHooks?.afterScan?.()
    const state: BrowserState = {
      profiles: [{ id: 'default', label: 'Default', scope: 'default' }, ...scan.profiles],
      pages: []
    }
    const temporary = this.writeRecoveryTemporary(state)
    try {
      this.revalidateRecoveryScan(scan)
      const result = guardedQuarantine(this.statePath, identity)
      if (result.outcome === 'changed') {
        throw fault('browser_error', 'persisted browser metadata changed during recovery')
      }
      if (result.outcome === 'moved-unexpected') {
        throw fault('browser_error', `persisted browser metadata changed during recovery; a file was set aside as ${basename(result.path)}`)
      }
      if (result.outcome === 'occupied' || result.outcome === 'failed') {
        throw fault('browser_error', `persisted browser metadata at ${this.statePath} could not be set aside`)
      }

      recoveryHooks?.afterQuarantine?.()
      try {
        linkSync(temporary.path, this.statePath)
      } catch (error) {
        if (isErrorCode(error, 'EEXIST')) {
          throw fault('browser_error', `persisted browser metadata changed during recovery; the unreadable file was set aside as ${basename(result.path)}`)
        }
        throw fault('browser_error', `persisted browser metadata at ${this.statePath} was set aside as ${result.path}, but rebuilt metadata could not be installed`)
      }
      return {
        state,
        recovery: { quarantinedPath: result.path, recoveredProfileIds: scan.profiles.map((profile) => profile.id) }
      }
    } finally {
      unlinkTemporaryFile(temporary)
    }
  }
  private persist(): void {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.statePath)
      chmodSync(this.statePath, 0o600)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw fault('browser_error', error instanceof Error ? 'browser metadata could not be saved' : 'browser metadata could not be saved')
    }
  }

  profilePath(profileId: string): string {
    const path = this.profileDirectory(profileId, true)
    if (!path) throw fault('browser_error', 'profile directory could not be created')
    return path
  }

  private profileDirectory(profileId: string, create: boolean): string | undefined {
    if (!isValidProfileId(profileId)) throw fault('invalid_argument', 'profile identifier is not a safe path')
    this.getProfile(profileId)

    const dataRoot = realpathSync(this.dataDir)
    if (dataRoot !== this.canonicalDataDir) {
      throw fault('invalid_argument', 'browser data directory changed after initialization')
    }
    const profilesRoot = resolve(this.canonicalDataDir, 'profiles')
    if (!isWithin(dataRoot, profilesRoot) || profilesRoot === dataRoot) {
      throw fault('invalid_argument', 'profile storage is outside the browser data directory')
    }

    let profilesInfo = lstatIfPresent(profilesRoot)
    if (!profilesInfo && create) {
      mkdirSync(profilesRoot, { recursive: true, mode: 0o700 })
      profilesInfo = lstatSync(profilesRoot)
    }
    if (!profilesInfo) return undefined
    if (profilesInfo.isSymbolicLink() || !profilesInfo.isDirectory()) {
      throw fault('invalid_argument', 'profile storage root is not a safe directory')
    }

    const path = resolve(profilesRoot, profileId)
    if (!isWithin(profilesRoot, path) || path === profilesRoot) {
      throw fault('invalid_argument', 'profile identifier is not a safe path')
    }
    let profileInfo = lstatIfPresent(path)
    if (!profileInfo && create) {
      mkdirSync(path, { recursive: false, mode: 0o700 })
      profileInfo = lstatSync(path)
    }
    if (profileInfo && (profileInfo.isSymbolicLink() || !profileInfo.isDirectory())) {
      throw fault('invalid_argument', 'profile path is not a safe directory')
    }
    return profileInfo ? path : undefined
  }

  private assertProfileHasNoPages(profileId: string): void {
    if (this.state.pages.some((page) => page.profileId === profileId)) {
      throw fault('browser_error', `profile ${profileId} is in use by a managed page`)
    }
  }

  clearProfileDirectory(profileId: string): void {
    this.getProfile(profileId)
    this.assertProfileHasNoPages(profileId)
    const path = this.profileDirectory(profileId, false)
    if (!path) return
    rmSync(path, { recursive: true, force: true })
    mkdirSync(path, { recursive: false, mode: 0o700 })
  }

  deleteProfile(profileId: string): void {
    const profile = this.getProfile(profileId)
    if (profile.id === 'default' || profile.scope === 'default') {
      throw fault('invalid_argument', 'the Default browser profile cannot be deleted')
    }
    this.assertProfileHasNoPages(profileId)
    const path = this.profileDirectory(profileId, false)
    if (path) rmSync(path, { recursive: true, force: true })

    const index = this.state.profiles.findIndex((item) => item.id === profileId)
    const [removed] = this.state.profiles.splice(index, 1)
    try {
      this.persist()
    } catch (error) {
      this.state.profiles.splice(index, 0, removed!)
      throw error
    }
  }

  listProfiles(): BrowserProfile[] {
    return this.state.profiles
      .map((profile) => ({ ...profile, ...(profile.source ? { source: { ...profile.source } } : {}) }))
      .sort((a, b) => a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.label.localeCompare(b.label))
  }

  markImported(profileId: string, source: { browserFamily: string; profileName?: string; importedAt: number }): void {
    const profile = this.getProfile(profileId)
    const previousScope = profile.scope
    const previousSource = profile.source
    profile.scope = 'imported'
    profile.source = { ...source }
    try {
      this.persist()
    } catch (error) {
      profile.scope = previousScope
      if (previousSource) profile.source = previousSource
      else delete profile.source
      throw error
    }
  }

  setPageProfile(pageId: string, profileId: string): BrowserPage {
    this.getProfile(profileId)
    return this.updatePage(pageId, (page) => { page.profileId = profileId })
  }

  getProfile(id: string): BrowserProfile {
    const profile = this.state.profiles.find((item) => item.id === id)
    if (!profile) throw fault('browser_profile_not_found', `profile ${id} does not exist`)
    return profile
  }

  createProfile(name: string): BrowserProfile {
    if (name.trim() === '') throw fault('invalid_argument', 'profile name must not be empty')
    if (this.state.profiles.some((profile) => profile.label === name.trim())) throw fault('invalid_argument', 'a browser profile with that label already exists')
    const profile: BrowserProfile = { id: `profile_${randomUUID().replaceAll('-', '')}`, label: name.trim(), scope: 'isolated' }
    this.state.profiles.push(profile)
    this.persist()
    this.markNoNativeUse(profile.id)
    return profile
  }

  markNoNativeUse(profileId: string): void {
    if (profileId === 'default') return
    const marker = join(this.profilePath(profileId), NO_NATIVE_PANE_MARKER)
    const info = lstatIfPresent(marker)
    if (info) {
      if (info.isSymbolicLink() || !info.isFile()) throw fault('invalid_argument', 'profile native marker is not a safe file')
      return
    }
    writeFileSync(marker, '', { flag: 'wx', mode: 0o600 })
    chmodSync(marker, 0o600)
  }

  clearNoNativeUse(profileId: string): void {
    if (profileId === 'default' || !isValidProfileId(profileId) || !this.state.profiles.some((profile) => profile.id === profileId)) return
    const dir = this.profileDirectory(profileId, false)
    if (dir) rmSync(join(dir, NO_NATIVE_PANE_MARKER), { force: true })
  }

  hasNoNativeUse(profileId: string): boolean {
    if (profileId === 'default') return false
    try {
      const dir = this.profileDirectory(profileId, false)
      if (!dir) return false
      const info = lstatIfPresent(join(dir, NO_NATIVE_PANE_MARKER))
      return Boolean(info && info.isFile() && !info.isSymbolicLink())
    } catch {
      return false
    }
  }

  listPages(): BrowserPage[] {
    return this.state.pages.map((page) => ({ ...page }))
  }

  getPage(id: string): BrowserPage {
    const page = this.state.pages.find((item) => item.browserPageId === id)
    if (!page) throw fault('browser_tab_not_found', `managed page ${id} does not exist`)
    return page
  }

  addPage(input: { worktreeId: string | null; profileId: string; url: string; title: string; active?: boolean }): BrowserPage {
    this.getProfile(input.profileId)
    const active = input.active ?? true
    if (active) {
      const group = this.state.pages.filter((page) => page.worktreeId === input.worktreeId)
      for (const page of group) page.active = false
    }
    const page: BrowserPage = {
      browserPageId: randomUUID(),
      worktreeId: input.worktreeId,
      profileId: input.profileId,
      index: this.state.pages.length,
      active,
      url: input.url,
      title: input.title,
      loadError: null
    }
    this.state.pages.push(page)
    this.persist()
    return { ...page }
  }

  updatePage(id: string, update: (page: BrowserPage) => void): BrowserPage {
    const page = this.getPage(id)
    update(page)
    this.normalizePages()
    this.persist()
    return { ...page }
  }

  removePage(id: string): BrowserPage {
    const page = this.getPage(id)
    this.state.pages = this.state.pages.filter((item) => item.browserPageId !== id)
    this.normalizePages()
    this.persist()
    return page
  }

  switchPage(id: string): BrowserPage {
    const page = this.getPage(id)
    for (const item of this.state.pages) if (item.worktreeId === page.worktreeId) item.active = item.browserPageId === id
    this.persist()
    return { ...page }
  }


  private normalizePages(): void {
    this.state.pages.forEach((page, index) => { page.index = index })
    const groups = new Map<string, BrowserPage[]>()
    for (const page of this.state.pages) {
      const key = page.worktreeId ?? '\0global'
      const group = groups.get(key) ?? []
      group.push(page)
      groups.set(key, group)
    }
    for (const group of groups.values()) {
      const active = group.find((page) => page.active) ?? group.at(-1)
      for (const page of group) page.active = page === active
    }
  }
}
