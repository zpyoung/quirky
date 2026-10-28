import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { validateValue, type Schema } from '@quirky/protocol'
import { fault } from '../runtime/errors'
export type BrowserProfile = { id: string; label: string; scope: 'default' | 'isolated' }
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

const PROFILE_SCHEMA: Schema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    scope: { type: 'string', enum: ['default', 'isolated'] }
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

export class BrowserStore {
  private readonly canonicalDataDir: string
  private readonly statePath: string
  private state: BrowserState

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const dataDirectoryInfo = lstatSync(dataDir)
    if (dataDirectoryInfo.isSymbolicLink() || !dataDirectoryInfo.isDirectory()) {
      throw fault('invalid_argument', 'browser data directory is not a safe directory')
    }
    chmodSync(dataDir, 0o700)
    this.canonicalDataDir = realpathSync(dataDir)
    this.statePath = join(this.canonicalDataDir, 'browser-state.json')
    this.state = this.readState()
    if (!this.state.profiles.some((profile) => profile.id === 'default')) {
      this.state.profiles.unshift({ id: 'default', label: 'Default', scope: 'default' })
      this.persist()
    }
  }

  private readState(): BrowserState {
    if (!existsSync(this.statePath)) return { profiles: [], pages: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown
    } catch {
      throw fault('browser_error', 'persisted browser metadata is unreadable')
    }
    const failure = validateValue(STATE_SCHEMA, parsed, 'browser metadata')
    if (failure) throw fault('browser_error', 'persisted browser metadata has an invalid schema')
    const state = parsed as BrowserState
    if (state.profiles.some((profile) => !isValidProfileId(profile.id)) || state.pages.some((page) => !isValidProfileId(page.profileId))) {
      throw fault('browser_error', 'persisted browser metadata contains an unsafe profile identifier')
    }
    if (state.pages.some((page) =>
      page.worktreeId !== null && typeof page.worktreeId !== 'string' ||
      page.loadError !== null && validateValue(LOAD_ERROR_SCHEMA, page.loadError, 'page load error')
    )) {
      throw fault('browser_error', 'persisted browser metadata contains invalid page metadata')
    }
    return state
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
    return [...this.state.profiles].sort((a, b) => a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.label.localeCompare(b.label))
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
    this.profilePath(profile.id)
    return profile
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
