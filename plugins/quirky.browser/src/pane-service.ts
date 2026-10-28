import { randomUUID } from 'node:crypto'
import { copyFileSync, constants, lstatSync, linkSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, fileURLToPath, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateValue, type PluginCaller, type PluginContext, type Schema } from '@quirky/protocol'
import { readRuntime } from '@quirky/protocol/node'
import type { PaneDownload, PaneMethod, PanePrompt, PaneState, PaneTab, PaneRequests, PaneFrame } from './pane-contract'
import type { BrowserPage, BrowserStore } from './profiles/store'
import type { BrowserRuntime, PaneControl, PaneInput, RuntimePaneDownloadProgress, RuntimePanePrompt } from './runtime/driver'
import { fault } from './runtime/errors'

type Worktree = { id: string; name: string; path: string; branch?: unknown }
type ResolveWorktree = (selector: string | undefined, caller: PluginCaller, allowNoScope: boolean) => Promise<string | 'all' | undefined>
type CreatePageResult = { browserPageId: string }
type NormalizedInput = { url: string; historyUrl: string; localPath?: string; directFile?: boolean; sourcePath?: string; error?: string }
type PromptState = { paneId: string; watchId: string; prompt: RuntimePanePrompt; timer: ReturnType<typeof setTimeout> }
type DownloadOwner = { paneId: string; pageId: string; guid: string; profileId: string; stagingPath: string; entry: PaneDownload }
type WatchLease = {
  paneId: string
  watchId: string
  pageId: string
  latest: { data: string; width: number; height: number } | null
  sequence: number
  waitingForAck?: number
  lastSentAt: number
  throttle?: ReturnType<typeof setTimeout>
  ackTimeout?: ReturnType<typeof setTimeout>
  startupTimeout?: ReturnType<typeof setTimeout>
}

const HISTORY_LIMIT = 200
const MAX_SUGGESTIONS = 8
const QUERY_MAX_BYTES = 2048
const WATCH_FRAME_INTERVAL_MS = 100
const WATCH_FRAME_ACK_TIMEOUT_MS = 30_000
const WATCH_NO_FRAME_TIMEOUT_MS = 30_000
const PROMPT_TIMEOUT_MS = 120_000
const MAX_DOWNLOADS_PER_PANE = 20
const PANE_TAB_SCHEMA: Schema = {
  type: 'object',
  properties: {
    id: { type: 'string' }, worktreeId: { type: 'string' }, mode: { type: 'string', enum: ['native', 'watch'] },
    page: {}, url: { type: 'string' }, title: { type: 'string' }, loading: { type: 'boolean' }, error: {},
    canGoBack: { type: 'boolean' }, canGoForward: { type: 'boolean' }, zoom: { type: 'number' },
    viewport: { type: 'string', enum: ['default', 'mobile-s', 'mobile-m', 'mobile-l', 'tablet', 'laptop', 'laptop-l', 'desktop'] },
    command: {}, find: { type: 'object', additionalProperties: true }, prompts: { type: 'array' }, downloads: { type: 'array' },
    profileId: { type: 'string' }, partition: { type: 'string' }, sourcePath: { type: 'string' }, preview: { type: 'object', additionalProperties: true }, tabId: { type: 'string' }
  },
  required: ['id', 'worktreeId', 'mode', 'page', 'url', 'title', 'loading', 'error', 'canGoBack', 'canGoForward', 'zoom', 'viewport', 'command', 'find', 'prompts', 'downloads', 'profileId', 'partition'],
  additionalProperties: true
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function safeHistoryAddress(value: string): string {
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    if (parsed.hostname.toLowerCase() === 'kagi.com' || parsed.hostname.toLowerCase().endsWith('.kagi.com')) {
      for (const key of [...parsed.searchParams.keys()]) {
        if (/^(?:token|session|session_token|kagi_session|kagi_session_token)$/i.test(key)) parsed.searchParams.delete(key)
      }
    }
    return parsed.href
  } catch {
    return value === 'about:blank' ? value : ''
  }
}

function safeUrl(value: string): string {
  if (value === 'about:blank') return value
  let parsed: URL
  try { parsed = new URL(value) } catch { throw fault('invalid_argument', 'address must be a valid absolute URL or search query') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
    throw fault('invalid_argument', 'browser navigation supports only HTTP, HTTPS, worktree files, or about:blank')
  }
  parsed.username = ''
  parsed.password = ''
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    for (const key of [...parsed.searchParams.keys()]) {
      if ((parsed.hostname.toLowerCase() === 'kagi.com' || parsed.hostname.toLowerCase().endsWith('.kagi.com')) &&
          /^(?:token|session|session_token|kagi_session|kagi_session_token)$/i.test(key)) parsed.searchParams.delete(key)
    }
  }
  return parsed.href
}
function matchingResourceUrl(value: string, expected: string): string | undefined {
  try {
    const resource = new URL(expected)
    const reported = new URL(value, resource)
    if (reported.origin !== resource.origin || reported.pathname !== resource.pathname || reported.search !== resource.search) return undefined
    return `${resource.href}${reported.hash}`
  } catch {
    return undefined
  }
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const octets = host.split('.')
  return octets.length === 4 && Number(octets[0]) === 127 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function searchAddress(query: string, engine: unknown): string {
  const encoded = new URLSearchParams({ q: query }).toString()
  switch (engine) {
    case 'duckduckgo': return `https://duckduckgo.com/?${encoded}`
    case 'bing': return `https://www.bing.com/search?${encoded}`
    case 'kagi': return `https://kagi.com/search?${encoded}`
    default: return `https://www.google.com/search?${encoded}`
  }
}

function normalizeInput(input: string, engine: unknown): NormalizedInput {
  const value = input.trim()
  if (value === '' || value === 'about:blank') return { url: 'about:blank', historyUrl: 'about:blank' }
  const windows = /^([A-Za-z]):[\\/](.*)$/.exec(value)
  if (windows) {
    const path = windows[2]!.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/')
    const url = `file:///${windows[1]!.toUpperCase()}:/${path}`
    return { url, historyUrl: url, localPath: value }
  }
  const unc = /^\\\\([^\\]+)\\([^\\]+)(.*)$/.exec(value)
  if (unc) {
    const tail = unc[3]!.replaceAll('\\', '/').split('/').filter(Boolean).map(encodeURIComponent)
    const url = `file://${encodeURIComponent(unc[1]!)}/${[unc[2]!, ...tail].map(encodeURIComponent).join('/')}`
    return { url, historyUrl: url, localPath: value }
  }
  if (isAbsolute(value)) {
    const url = pathToFileURL(value).href
    return { url, historyUrl: url, localPath: value }
  }
  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) {
    let parsed: URL
    try { parsed = new URL(value) } catch { throw fault('invalid_argument', 'address is not a valid URL') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
      throw fault('invalid_argument', `unsupported browser URL scheme: ${parsed.protocol}`)
    }
    const url = safeUrl(value)
    return { url, historyUrl: safeHistoryAddress(url), ...(parsed.protocol === 'file:' ? { localPath: fileURLToPath(new URL(url)) } : {}) }
  }
  const ipv6Loopback = /^::1(?::(\d{1,5}))?(\/[^\s]*)?$/i.exec(value)
  if (ipv6Loopback) {
    const candidate = new URL(`http://[::1]${ipv6Loopback[1] ? `:${ipv6Loopback[1]}` : ''}${ipv6Loopback[2] ?? '/'}`)
    const url = safeUrl(candidate.href)
    return { url, historyUrl: safeHistoryAddress(url) }
  }
  if (/\s/.test(value)) {
    const url = searchAddress(value, engine)
    return { url, historyUrl: url }
  }
  const hostPort = /^(\[[0-9a-f:]+\]|[^/\s:]+)(?::(\d{1,5}))?(\/[^\s]*)?$/i.exec(value)
  if (hostPort && (hostPort[1]!.toLowerCase() === 'localhost' || hostPort[1]!.toLowerCase().endsWith('.localhost') ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostPort[1]!) || /^\[[0-9a-f:]+\]$/i.test(hostPort[1]!) || hostPort[1]!.includes('.'))) {
    const candidate = new URL(`https://${value}`)
    const protocol = isLocalHost(candidate.hostname) ? 'http:' : 'https:'
    candidate.protocol = protocol
    const url = safeUrl(candidate.href)
    return { url, historyUrl: safeHistoryAddress(url) }
  }
  const scheme = /^[A-Za-z][A-Za-z\d+.-]*:/.exec(value)
  if (scheme) throw fault('invalid_argument', `unsupported browser URL scheme: ${scheme[0].slice(0, -1)}`)
  const url = searchAddress(value, engine)
  return { url, historyUrl: url }
}

function zoomLevel(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(-3, Math.min(5, Math.round(value * 2) / 2))
}

function safeFileName(value: string): string {
  const leaf = value.replaceAll('\\', '/').split('/').at(-1) ?? ''
  let name = leaf.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '_').replace(/^\.+/, '').trim().replace(/[. ]+$/, '')
  if (name === '') name = 'download'
  while (Buffer.byteLength(name, 'utf8') > 180) name = name.slice(0, -1)
  return name
}

function within(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function resourceType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.md': case '.markdown': case '.txt': case '.log': return 'text/plain'
    case '.json': return 'application/json'
    case '.csv': return 'text/csv'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.avif': return 'image/avif'
    case '.bmp': return 'image/bmp'
    case '.ico': return 'image/x-icon'
    case '.pdf': return 'application/pdf'
    default: throw fault('invalid_argument', 'the public file resource API does not support this worktree document type')
  }
}
function isDirectHtml(path: string): boolean {
  const extension = extname(path).toLowerCase()
  return extension === '.html' || extension === '.htm'
}
const SOURCE_FILE_EXTENSIONS: Record<string, true> = {
  '.html': true, '.htm': true, '.md': true, '.markdown': true, '.txt': true, '.log': true,
  '.json': true, '.jsonc': true, '.csv': true, '.css': true, '.js': true, '.mjs': true,
  '.cjs': true, '.jsx': true, '.ts': true, '.tsx': true, '.xml': true, '.yaml': true,
  '.yml': true, '.toml': true, '.sh': true, '.py': true, '.rb': true, '.go': true,
  '.rs': true, '.java': true, '.c': true, '.h': true, '.cpp': true, '.hpp': true,
  '.sql': true, '.graphql': true, '.gql': true
}

function isSourceDocument(path: string): boolean {
  return SOURCE_FILE_EXTENSIONS[extname(path).toLowerCase()] === true
}

function isSupportedSafeAddress(value: string): boolean {
  return value === 'about:blank' || /^https?:/i.test(value) || /^file:/i.test(value)
}

export class PaneService {
  private readonly db
  private readonly tabs = new Map<string, PaneTab>()
  private readonly activeByWorktree = new Map<string, string>()
  private readonly updatedAt = new Map<string, number>()
  private readonly watches = new Map<string, WatchLease>()
  private readonly prompts = new Map<string, PromptState>()
  private readonly downloads = new Map<string, DownloadOwner>()
  private readonly resources = new Map<string, { url: string; revoke(): void }>()
  private active = true

  constructor(
    private readonly context: PluginContext,
    private readonly store: BrowserStore,
    private readonly runtime: BrowserRuntime,
    private readonly resolveWorktree: ResolveWorktree,
    private readonly listWorktrees: () => Promise<Worktree[]>
  ) {
    this.db = context.openStore([
      `CREATE TABLE IF NOT EXISTS browser_pane_tabs (id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL, active INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
       CREATE INDEX IF NOT EXISTS browser_pane_tabs_worktree ON browser_pane_tabs(worktree_id, updated_at DESC);
       CREATE TABLE IF NOT EXISTS browser_pane_history (url TEXT PRIMARY KEY, title TEXT NOT NULL, visited_at INTEGER NOT NULL);`
    ])
    this.restoreTabs()
  }

  async call(method: PaneMethod, params: Record<string, unknown>, caller: PluginCaller): Promise<unknown> {
    if (!this.active) throw fault('browser_error', 'browser pane service is shutting down')
    switch (method) {
      case 'paneOpen': return await this.paneOpen(params as PaneRequests['paneOpen'], caller)
      case 'paneState': return await this.paneState(params as PaneRequests['paneState'], caller)
      case 'paneNavigate': return await this.paneNavigate(params as PaneRequests['paneNavigate'])
      case 'paneControl': return await this.paneControl(params as PaneRequests['paneControl'])
      case 'paneReport': return await this.paneReport(params as PaneRequests['paneReport'])
      case 'paneClose': return await this.paneClose(params as PaneRequests['paneClose'], caller)
      case 'paneSuggestions': return await this.paneSuggestions(params as PaneRequests['paneSuggestions'], caller)
      case 'paneWatch': return await this.paneWatch(params as PaneRequests['paneWatch'])
      case 'paneWatchStop': return await this.paneWatchStop(params as PaneRequests['paneWatchStop'])
      case 'paneInput': return await this.paneInput(params as PaneRequests['paneInput'])
      case 'paneRespond': return await this.paneRespond(params as PaneRequests['paneRespond'], caller)
      case 'paneDownload': return await this.paneDownload(params as PaneRequests['paneDownload'], caller)
      case 'paneFrameAck': return this.paneFrameAck(params)
    }
  }

  async setPaneProfile(paneId: string, profileId: string): Promise<PaneTab> {
    const tab = this.requirePane(paneId)
    this.store.getProfile(profileId)
    if (tab.profileId === profileId) return structuredClone(tab)
    if (tab.mode === 'watch') {
      const watch = this.watches.get(paneId)
      if (watch) await this.stopWatch(watch)
      this.clearPromptsForPane(paneId)
      tab.page = null
      tab.error = null
      tab.canGoBack = false
      tab.canGoForward = false
    }
    tab.profileId = profileId
    tab.partition = this.partition(profileId)
    this.saveTab(tab)
    this.emitChanged()
    return structuredClone(tab)
  }
  listPanes(): PaneTab[] {
    return [...this.tabs.values()].map((tab) => structuredClone(tab))
  }

  async deactivate(): Promise<void> {
    this.active = false
    const pendingPrompts = [...this.prompts.values()]
    this.prompts.clear()
    for (const prompt of pendingPrompts) clearTimeout(prompt.timer)
    await Promise.all(pendingPrompts.map(async (prompt) => {
      await prompt.prompt.respond({ accept: false }).catch(() => {})
    }))
    for (const tab of this.tabs.values()) tab.prompts = []
    for (const watch of this.watches.values()) await this.stopWatch(watch)
    for (const resource of this.resources.values()) resource.revoke()
    this.resources.clear()
  }

  private restoreTabs(): void {
    for (const row of this.db.all<{ id: string; worktree_id: string; active: number; updated_at: number; data: string }>(
      'SELECT id, worktree_id, active, updated_at, data FROM browser_pane_tabs ORDER BY updated_at ASC'
    )) {
      let value: unknown
      try { value = JSON.parse(row.data) as unknown } catch { this.db.run('DELETE FROM browser_pane_tabs WHERE id=?', row.id); continue }
      if (validateValue(PANE_TAB_SCHEMA, value, 'browser pane state')) {
        this.db.run('DELETE FROM browser_pane_tabs WHERE id=?', row.id)
        continue
      }
      const tab = value as PaneTab
      if (!tab.id || tab.id !== row.id || !tab.worktreeId || tab.worktreeId !== row.worktree_id) {
        this.db.run('DELETE FROM browser_pane_tabs WHERE id=?', row.id)
        continue
      }
      tab.profileId = typeof tab.profileId === 'string' ? tab.profileId : 'default'
      try { this.store.getProfile(tab.profileId) } catch { tab.profileId = 'default' }
      tab.partition = this.partition(tab.profileId)
      tab.command = null
      tab.loading = false
      tab.prompts = []
      tab.downloads = []
      this.tabs.set(tab.id, tab)
      this.updatedAt.set(tab.id, row.updated_at)
      if (row.active === 1) this.activeByWorktree.set(tab.worktreeId, tab.id)
    }
  }

  private persistTab(tab: PaneTab): void {
    const copy = structuredClone(tab)
    copy.command = null
    copy.prompts = []
    copy.downloads = []
    if (copy.preview) {
      const fileUrl = pathToFileURL(copy.preview.path).href
      copy.url = fileUrl
      copy.preview.url = fileUrl
    }
    const existing = this.db.get<{ active: number }>('SELECT active FROM browser_pane_tabs WHERE id=?', tab.id)
    const updatedAt = Math.max(Date.now(), (this.updatedAt.get(tab.id) ?? 0) + 1)
    this.updatedAt.set(tab.id, updatedAt)
    this.db.run(
      'INSERT INTO browser_pane_tabs(id, worktree_id, active, updated_at, data) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET worktree_id=excluded.worktree_id, active=excluded.active, updated_at=excluded.updated_at, data=excluded.data',
      tab.id,
      tab.worktreeId,
      this.activeByWorktree.get(tab.worktreeId) === tab.id || (!existing && !this.activeByWorktree.has(tab.worktreeId)) ? 1 : 0,
      updatedAt,
      JSON.stringify(copy)
    )
  }

  private saveTab(tab: PaneTab): void {
    this.tabs.set(tab.id, tab)
    this.persistTab(tab)
  }

  private requirePane(id: string): PaneTab {
    const tab = this.tabs.get(id)
    if (!tab) throw fault('browser_tab_not_found', `browser pane ${id} does not exist`)
    return tab
  }

  private copyTab(tab: PaneTab): PaneTab {
    return structuredClone(tab)
  }

  private partition(profileId: string): string {
    return `persist:quirky-browser-${profileId}`
  }

  private defaultZoom(): number {
    return zoomLevel(this.context.getSetting('defaultZoom'), 0)
  }

  private defaultHomePage(): string {
    const setting = this.context.getSetting('defaultHomePage')
    return typeof setting === 'string' && setting.trim() !== '' ? setting : 'about:blank'
  }

  private searchEngine(): unknown {
    const engine = this.context.getSetting('defaultSearchEngine')
    return engine === 'duckduckgo' || engine === 'bing' || engine === 'kagi' ? engine : 'google'
  }

  private async worktreeInfo(id: string): Promise<Worktree> {
    const worktrees = await this.listWorktrees()
    const match = worktrees.find((worktree) => worktree.id === id)
    if (!match) throw fault('browser_tab_not_found', `worktree ${id} no longer exists`)
    return match
  }

  private async normalized(input: string, worktree: Worktree): Promise<NormalizedInput> {
    const normalized = normalizeInput(input, this.searchEngine())
    if (!normalized.localPath) return normalized
    const explicit = this.canonicalExplicitFile(normalized.localPath)
    const url = explicit.exists ? pathToFileURL(explicit.path).href : safeUrl(normalized.url)
    const historyUrl = safeHistoryAddress(url) || url
    if (isDirectHtml(explicit.path) || !explicit.exists) {
      const sourcePath = explicit.exists ? this.sourcePathWithinWorktree(worktree, explicit.path) : undefined
      return {
        url,
        historyUrl,
        localPath: explicit.path,
        directFile: true,
        ...(sourcePath ? { sourcePath } : {}),
        ...(explicit.exists ? {} : { error: `Local file does not exist: ${explicit.path}` })
      }
    }
    const absolute = this.resolveWorkspaceFile(worktree, explicit.path)
    resourceType(absolute)
    return { ...normalized, url, localPath: absolute, sourcePath: this.sourcePathWithinWorktree(worktree, absolute), historyUrl }
  }

  private sourcePathWithinWorktree(worktree: Worktree, path: string): string | undefined {
    if (!isSourceDocument(path)) return undefined
    try { return this.resolveWorkspaceFile(worktree, path) } catch { return undefined }
  }

  private canonicalExplicitFile(requested: string): { path: string; exists: boolean } {
    const candidate = resolve(requested)
    try {
      const canonical = realpathSync(candidate)
      const info = lstatSync(canonical)
      if (!info.isFile() || info.isSymbolicLink()) throw fault('invalid_argument', 'local browser navigation requires a regular file')
      return { path: canonical, exists: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { path: candidate, exists: false }
      throw error
    }
  }

  private resolveWorkspaceFile(worktree: Worktree, requested: string): string {
    let root: string
    let candidate: string
    try {
      root = realpathSync(worktree.path)
      candidate = realpathSync(isAbsolute(requested) ? requested : join(root, requested))
    } catch {
      throw fault('invalid_argument', 'local browser previews must name an existing worktree file')
    }
    if (!within(root, candidate)) throw fault('invalid_argument', 'local browser previews are restricted to the canonical worktree root')
    const info = lstatSync(candidate)
    if (!info.isFile() || info.isSymbolicLink()) throw fault('invalid_argument', 'local browser previews require a regular worktree file')

    return candidate
  }

  private async resourceFor(tab: PaneTab, path: string): Promise<string> {
    const worktree = await this.worktreeInfo(tab.worktreeId)
    const canonical = this.resolveWorkspaceFile(worktree, path)
    const current = this.resources.get(tab.id)
    if (current && current.url === tab.preview?.url && tab.preview.path === canonical) return current.url
    current?.revoke()
    const created = await this.context.createFileResource({ path: canonical, contentType: resourceType(canonical), disposition: 'inline' })
    const runtime = readRuntime(this.context.home)
    if (!runtime) {
      created.revoke()
      throw fault('browser_unavailable', 'the daemon runtime URL is unavailable for a passive file resource')
    }
    const resource = { url: new URL(created.url, `http://127.0.0.1:${runtime.port}`).href, revoke: created.revoke }
    this.resources.set(tab.id, resource)
    tab.preview = { path: canonical, url: resource.url }
    tab.sourcePath = this.sourcePathWithinWorktree(worktree, canonical)
    tab.url = resource.url
    return resource.url
  }

  private async openLocalDocument(tab: PaneTab, normalized: NormalizedInput): Promise<string> {
    if (!normalized.localPath) return normalized.url
    if (normalized.directFile) {
      this.releaseResource(tab.id)
      tab.preview = undefined
      tab.sourcePath = normalized.sourcePath
      tab.url = normalized.url
      return normalized.url
    }
    return await this.resourceFor(tab, normalized.localPath)
  }

  private releaseResource(tabId: string): void {
    const resource = this.resources.get(tabId)
    if (resource) resource.revoke()
    this.resources.delete(tabId)
  }

  private async paneOpen(request: PaneRequests['paneOpen'], caller: PluginCaller): Promise<PaneTab> {
    if (typeof request.worktree !== 'string' || request.worktree.trim() === '') throw fault('invalid_argument', 'worktree is required')
    const worktreeId = await this.resolveWorktree(request.worktree, caller, false)
    if (typeof worktreeId !== 'string' || worktreeId === 'all') throw fault('invalid_argument', 'browser panes require one concrete worktree')
    const worktree = await this.worktreeInfo(worktreeId)
    const requestedPage = request.page
    const mode = request.mode ?? (requestedPage ? 'watch' : 'native')
    if (mode !== 'native' && mode !== 'watch') throw fault('invalid_argument', 'mode must be native or watch')
    if (requestedPage && mode !== 'watch') throw fault('invalid_argument', 'managed pages can only be opened in Watch mode')
    let profileId = request.profile ?? 'default'
    this.store.getProfile(profileId)
    let page: BrowserPage | undefined
    let url: string
    let title = ''
    let localPath: string | undefined
    let normalizedInput: NormalizedInput | undefined
    if (requestedPage) {
      page = this.store.getPage(requestedPage)
      if (page.worktreeId !== worktreeId) throw fault('invalid_argument', 'Watch pages must belong to the pane worktree')
      if (request.profile !== undefined && request.profile !== page.profileId) throw fault('invalid_argument', 'Watch panes use the managed page browser profile')
      profileId = page.profileId
      this.store.getProfile(profileId)
      url = safeUrl(page.url)
      title = page.title
    } else {
      normalizedInput = await this.normalized(request.url ?? this.defaultHomePage(), worktree)
      url = normalizedInput.url
      localPath = normalizedInput.localPath
    }
    const tab: PaneTab = {
      id: randomUUID(),
      worktreeId,
      mode,
      page: page?.browserPageId ?? null,
      url,
      title,
      loading: false,
      error: page?.loadError?.description ?? normalizedInput?.error ?? null,
      canGoBack: false,
      canGoForward: false,
      zoom: this.defaultZoom(),
      viewport: 'default',
      command: null,
      find: { text: '', current: 0, total: 0 },
      prompts: [],
      downloads: [],
      profileId,
      partition: this.partition(profileId),
      ...(normalizedInput?.sourcePath ? { sourcePath: normalizedInput.sourcePath } : {}),
      ...(localPath && !normalizedInput?.directFile ? { preview: { path: localPath, url } } : {})
    }
    this.setActive(tab)
    this.saveTab(tab)
    let createdPageId: string | undefined
    try {
      if (localPath && !normalizedInput?.directFile) await this.resourceFor(tab, localPath)
      if (mode === 'watch' && !page) {
        page = await this.createPage(worktreeId, profileId, tab.url)
        createdPageId = page.browserPageId
        tab.page = page.browserPageId
        tab.url = safeHistoryAddress(page.url) || tab.url
        tab.title = page.title
        tab.error = page.loadError?.description ?? null
        this.saveTab(tab)
      }
      const hosted = objectValue(await this.context.call('quirky.terminal/openViewTab', {
        workspace: worktreeId,
        viewId: 'view:quirky.browser/page',
        key: `browser:${tab.id}`,
        title: 'Browser',
        input: { pane: tab.id },
        closeMethod: 'quirky.browser/paneClose',
        closeParams: { pane: tab.id, fromTab: true },
        activate: true
      }))
      if (!hosted || typeof hosted.tab !== 'string') throw fault('browser_error', 'terminal did not return the hosted browser tab ID')
      tab.tabId = hosted.tab
      this.saveTab(tab)
    } catch (error) {
      await this.removePaneState(tab)
      if (createdPageId) await this.closeCreatedPage(createdPageId)
      throw error
    }
    this.recordHistory(tab.preview ? pathToFileURL(tab.preview.path).href : tab.url, tab.title)
    this.emitChanged()
    return this.copyTab(tab)
  }

  private async createPage(worktreeId: string, profileId: string, url: string): Promise<BrowserPage> {
    const created = objectValue(await this.context.call('quirky.browser/tabCreate', {
      worktree: `id:${worktreeId}`,
      profile: profileId,
      url
    })) as CreatePageResult | undefined
    if (!created || typeof created.browserPageId !== 'string') throw fault('browser_error', 'browser runtime did not return the created agent page ID')
    return this.store.getPage(created.browserPageId)
  }

  private async closeCreatedPage(pageId: string): Promise<void> {
    try { await this.context.call('quirky.browser/tabClose', { page: pageId }) } catch { /* the helper may already have removed the newly created page */ }
  }

  private setActive(tab: PaneTab): void {
    for (const current of this.tabs.values()) {
      if (current.worktreeId !== tab.worktreeId) continue
      this.db.run('UPDATE browser_pane_tabs SET active=0 WHERE id=?', current.id)
    }
    this.activeByWorktree.set(tab.worktreeId, tab.id)
  }

  private async ensureRestoredResource(tab: PaneTab): Promise<void> {
    if (!tab.preview?.path || this.resources.has(tab.id)) return
    const worktree = await this.worktreeInfo(tab.worktreeId)
    const path = this.resolveWorkspaceFile(worktree, tab.preview.path)
    if (isDirectHtml(path)) {
      const url = pathToFileURL(path).href
      tab.preview = { path, url }
      tab.sourcePath = this.sourcePathWithinWorktree(worktree, path)
      tab.url = url
    } else {
      await this.resourceFor(tab, path)
    }
    this.saveTab(tab)
  }

  private async paneState(request: PaneRequests['paneState'], caller: PluginCaller): Promise<PaneState> {
    const selector = request.worktree
    const worktree = selector === undefined ? undefined : await this.resolveWorktree(selector, caller, true)
    const selected = [...this.tabs.values()].filter((tab) => worktree === undefined || worktree === 'all' || tab.worktreeId === worktree)
    for (const tab of selected) {
      if (tab.preview) await this.ensureRestoredResource(tab)
      if (tab.mode === 'watch' && tab.page) {
        try {
          const page = this.store.getPage(tab.page)
          if (tab.error === null) await this.syncFromPage(tab, page)
        } catch {
          tab.page = null
          tab.error ??= 'The managed page was closed; this pane cannot retarget automatically.'
          tab.loading = false
          this.saveTab(tab)
        }
      }
    }
    const active = selected.filter((tab) => this.activeByWorktree.get(tab.worktreeId) === tab.id)
      .sort((a, b) => (this.updatedAt.get(b.id) ?? 0) - (this.updatedAt.get(a.id) ?? 0))[0]
    return {
      tabs: selected.map((tab) => this.copyTab(tab)),
      active: active?.id ?? null,
      history: this.history()
    }
  }

  private async syncFromPage(tab: PaneTab, page: BrowserPage): Promise<void> {
    let address: string
    if (page.url === 'about:blank' || /^https?:/i.test(page.url)) {
      address = safeHistoryAddress(page.url) || tab.url
    } else if (page.url.startsWith('file:')) {
      address = safeHistoryAddress(page.url) || tab.url
    } else {
      tab.error = 'The managed page navigated to an unsupported URL scheme.'
      tab.loading = false
      this.saveTab(tab)
      return
    }
    if (tab.preview && page.url !== tab.preview.url) this.releaseResourceWhenLeaving(tab)
    if (!tab.preview && page.url !== tab.url) tab.sourcePath = undefined
    tab.url = tab.preview?.url ?? address
    tab.title = page.title
    tab.loading = false
    tab.error = page.loadError?.description ?? null
    this.saveTab(tab)
  }

  private async paneNavigate(request: PaneRequests['paneNavigate']): Promise<PaneTab> {
    const tab = this.requirePane(request.pane)
    const worktree = await this.worktreeInfo(tab.worktreeId)
    const normalized = await this.normalized(request.input, worktree)
    this.releaseResourceWhenLeaving(tab, normalized.directFile ? undefined : normalized.localPath)
    const localUrl = await this.openLocalDocument(tab, normalized)
    const targetUrl = safeUrl(localUrl)
    tab.error = normalized.error ?? null
    if (normalized.directFile) tab.sourcePath = normalized.sourcePath
    else if (!normalized.localPath) tab.sourcePath = undefined
    tab.loading = true
    tab.url = targetUrl
    tab.command = tab.mode === 'native' ? { id: randomUUID(), action: 'navigate', url: targetUrl } : null
    this.saveTab(tab)
    this.recordHistory(normalized.historyUrl, tab.title)
    this.emitChanged()
    if (tab.mode === 'native') return this.copyTab(tab)
    const page = this.pageFor(tab)
    try {
      const result = await this.runtime.paneNavigate(page, targetUrl)
      tab.url = safeHistoryAddress(result.url) || targetUrl
      tab.title = result.title
      tab.loading = false
      tab.error = result.errorText ?? null
      this.store.updatePage(page.browserPageId, (record) => {
        record.url = tab.url
        record.title = tab.title
        record.loadError = result.errorText ? { code: 'navigation_failed', description: result.errorText.slice(0, 300), validatedUrl: targetUrl } : null
      })
      if (!result.errorText) this.recordHistory(normalized.historyUrl, result.title)
      if (tab.zoom !== 0) await this.runtime.paneControl(page, { action: 'zoom', level: tab.zoom })
      this.saveTab(tab)
      this.emitChanged()
      return this.copyTab(tab)
    } catch (error) {
      tab.loading = false
      tab.error = error instanceof Error ? error.message : String(error)
      this.saveTab(tab)
      this.emitChanged()
      throw error
    }
  }

  private releaseResourceWhenLeaving(tab: PaneTab, nextPath?: string): void {
    if (tab.preview && tab.preview.path !== nextPath) {
      this.releaseResource(tab.id)
      tab.preview = undefined
      tab.sourcePath = undefined
    }
  }

  private async paneControl(request: PaneRequests['paneControl']): Promise<PaneTab> {
    const tab = this.requirePane(request.pane)
    if (request.action === 'viewport') {
      if (!request.preset) throw fault('invalid_argument', 'viewport control requires a preset')
      tab.viewport = request.preset
      if (tab.mode === 'watch') {
        const page = this.pageFor(tab)
        await this.runtime.paneControl(page, { action: 'viewport', preset: request.preset })
        tab.error = null
      }
      this.saveTab(tab)
      this.emitChanged()
      return this.copyTab(tab)
    }
    if (request.action === 'zoom') {
      if (request.level === undefined) throw fault('invalid_argument', 'zoom control requires a level')
      const level = zoomLevel(request.level, tab.zoom)
      if (tab.mode === 'watch') await this.runtime.paneControl(this.pageFor(tab), { action: 'zoom', level })
      if (tab.mode === 'watch') tab.error = null
      tab.zoom = level
      tab.command = tab.mode === 'native' ? { id: randomUUID(), action: 'zoom', level } : null
    } else if (request.action === 'find') {
      const text = request.text ?? ''
      if (Buffer.byteLength(text, 'utf8') > 2048) throw fault('invalid_argument', 'find query exceeds 2,048 UTF-8 bytes')
      const changed = tab.find.text !== text
      if (tab.mode === 'watch') {
        const result = await this.runtime.paneControl(this.pageFor(tab), {
          action: 'find', text, forward: changed ? true : request.forward ?? true, findCurrent: changed ? 0 : tab.find.current
        })
        tab.find = {
          text,
          current: result.total && result.found ? changed ? 1 : ((tab.find.current - 1 + (request.forward === false ? result.total - 1 : 1)) % result.total) + 1 : 0,
          total: result.total ?? 0
        }
        tab.command = null
        tab.error = null
      } else {
        tab.find = { ...tab.find, text }
        tab.command = { id: randomUUID(), action: 'find', text, ...(request.forward === undefined ? {} : { forward: request.forward }) }
      }
    } else {
      if (tab.mode === 'watch') {
        const result = await this.runtime.paneControl(this.pageFor(tab), request as PaneControl)
        if (result.url) tab.url = safeHistoryAddress(result.url) || tab.url
        if (result.title !== undefined) tab.title = result.title
        tab.canGoBack = result.canGoBack ?? tab.canGoBack
        tab.canGoForward = result.canGoForward ?? tab.canGoForward
        if (request.action === 'back' || request.action === 'forward') this.recordHistory(tab.url, tab.title)
        tab.command = null
        tab.error = null
      } else {
        tab.command = { id: randomUUID(), action: request.action, ...(request.text === undefined ? {} : { text: request.text }), ...(request.forward === undefined ? {} : { forward: request.forward }) }
      }
    }
    this.saveTab(tab)
    this.emitChanged()
    return this.copyTab(tab)
  }

  private async paneReport(params: PaneRequests['paneReport']): Promise<PaneTab> {
    const tab = this.requirePane(params.pane)
    if (typeof params.tabId !== 'string' || params.tabId !== tab.tabId) throw fault('browser_tab_changed', 'pane report came from a stale hosted tab')
    if (params.command !== undefined) {
      if (!tab.command || tab.command.id !== params.command) throw fault('browser_tab_changed', 'pane report command identity is stale')
    } else if (tab.command) {
      throw fault('browser_tab_changed', 'pane report must acknowledge the pending command identity')
    }
    const previousUrl = tab.url
    let untrustedFileReport = false
    if (params.url !== undefined) {
      const currentResource = this.resources.get(tab.id)
      const resourceUrl = currentResource ? matchingResourceUrl(params.url, currentResource.url) : undefined
      if (resourceUrl) {
        tab.url = resourceUrl
      } else {
        const reported = safeUrl(params.url)
        if (reported.startsWith('file:')) {
          this.releaseResourceWhenLeaving(tab)
          if (params.command === undefined) untrustedFileReport = true
          if (params.command === undefined) {
            tab.preview = undefined
            tab.sourcePath = undefined
          }
          tab.url = safeHistoryAddress(reported) || reported
        } else {
          this.releaseResourceWhenLeaving(tab)
          tab.url = safeHistoryAddress(reported) || reported
        }
      }
    }
    if (params.title !== undefined) tab.title = params.title.slice(0, 4096)
    if (params.loading !== undefined) tab.loading = params.loading
    if (params.error !== undefined) tab.error = params.error === null ? null : params.error.slice(0, 500)
    if (params.canGoBack !== undefined) tab.canGoBack = params.canGoBack
    if (params.canGoForward !== undefined) tab.canGoForward = params.canGoForward
    if (params.findCurrent !== undefined || params.findTotal !== undefined) {
      const total = Math.max(0, Math.min(1_000_000, Math.trunc(params.findTotal ?? tab.find.total)))
      const current = Math.max(0, Math.min(total, Math.trunc(params.findCurrent ?? tab.find.current)))
      tab.find = { ...tab.find, current, total }
    }
    tab.command = null
    if (!untrustedFileReport && !tab.loading && tab.url !== previousUrl) this.recordHistory(tab.preview ? pathToFileURL(tab.preview.path).href : tab.url, tab.title)
    this.saveTab(tab)
    this.emitChanged()
    return this.copyTab(tab)
  }

  private async paneClose(request: PaneRequests['paneClose'], caller: PluginCaller): Promise<{ closed: true }> {
    if (request.fromTab && (caller.role !== 'plugin' || caller.pluginId !== 'quirky.terminal')) {
      throw fault('invalid_argument', 'fromTab is reserved for the terminal hosted-tab close hook')
    }
    const tab = this.tabs.get(request.pane)
    if (!tab) return { closed: true }
    if (!request.fromTab && tab.tabId) {
      await this.context.call('quirky.terminal/closeTab', { tab: tab.tabId })
      if (!this.tabs.has(tab.id)) return { closed: true }
    }
    await this.removePaneState(tab)
    return { closed: true }
  }

  private async removePaneState(tab: PaneTab): Promise<void> {
    const watch = this.watches.get(tab.id)
    if (watch) await this.stopWatch(watch)
    this.clearPromptsForPane(tab.id)
    this.releaseResource(tab.id)
    this.tabs.delete(tab.id)
    this.updatedAt.delete(tab.id)
    this.db.run('DELETE FROM browser_pane_tabs WHERE id=?', tab.id)
    if (this.activeByWorktree.get(tab.worktreeId) === tab.id) {
      this.activeByWorktree.delete(tab.worktreeId)
      const fallback = [...this.tabs.values()].filter((candidate) => candidate.worktreeId === tab.worktreeId).sort((a, b) => (this.updatedAt.get(b.id) ?? 0) - (this.updatedAt.get(a.id) ?? 0))[0]
      if (fallback) this.activeByWorktree.set(tab.worktreeId, fallback.id)
    }
    this.emitChanged()
  }

  private async paneSuggestions(request: PaneRequests['paneSuggestions'], caller: PluginCaller) {
    if (typeof request.query !== 'string') throw fault('invalid_argument', 'query must be a string')
    if (Buffer.byteLength(request.query, 'utf8') > QUERY_MAX_BYTES) return { suggestions: [] }
    const worktreeId = await this.resolveWorktree(request.worktree, caller, false)
    if (typeof worktreeId !== 'string' || worktreeId === 'all') throw fault('invalid_argument', 'suggestions require one concrete worktree')
    const query = request.query.trim().toLowerCase()
    const candidates: Array<{ url: string; title: string; kind: 'history' | 'search' | 'document' }> = []
    for (const item of this.history()) {
      if (query === '' || item.url.toLowerCase().includes(query) || item.title.toLowerCase().includes(query)) {
        candidates.push({ url: item.url, title: item.title || item.url, kind: 'history' })
      }
    }
    if (query !== '') {
      try {
        const result = objectValue(await this.context.call('quirky.editor/quickOpen', {
          worktree: `id:${worktreeId}`, action: 'search', query: request.query, limit: MAX_SUGGESTIONS
        }))
        const worktree = await this.worktreeInfo(worktreeId)
        const results = Array.isArray(result?.results) ? result.results : []
        for (const item of results) {
          const value = objectValue(item)
          if (!value || typeof value.path !== 'string' || typeof value.name !== 'string') continue
          try {
            const path = this.resolveWorkspaceFile(worktree, join(worktree.path, value.path))
            candidates.push({ url: pathToFileURL(path).href, title: value.name, kind: 'document' })
          } catch { /* editor inventory results are re-canonicalized before they become suggestions */ }
        }
      } catch { /* a disabled editor contributes no document suggestions */ }
    }
    const suggestions: Array<{ url: string; title: string; kind: 'history' | 'search' | 'document' }> = []
    const seen = new Set<string>()
    for (const item of candidates) {
      const url = safeHistoryAddress(item.url)
      if (!url || seen.has(url)) continue
      if (suggestions.length >= (query === '' ? MAX_SUGGESTIONS : MAX_SUGGESTIONS - 1)) break
      seen.add(url)
      suggestions.push({ ...item, url })
    }
    if (query !== '') {
      const url = safeHistoryAddress(searchAddress(request.query, this.searchEngine()))
      const duplicate = suggestions.findIndex((item) => item.url === url)
      const search = { url, title: `Search for ${request.query}`, kind: 'search' as const }
      if (duplicate >= 0) suggestions[duplicate] = search
      else suggestions.push(search)
    }
    return { suggestions }
  }

  private async paneWatch(request: PaneRequests['paneWatch']): Promise<{ watchId: string }> {
    const tab = this.requirePane(request.pane)
    const active = this.watches.get(tab.id)
    if (active) return { watchId: active.watchId }
    if (tab.preview) await this.ensureRestoredResource(tab)
    if (tab.mode === 'native') {
      const page = await this.createPage(tab.worktreeId, tab.profileId, safeUrl(tab.url))
      tab.mode = 'watch'
      tab.page = page.browserPageId
      tab.url = safeHistoryAddress(page.url) || tab.url
      tab.title = page.title
      tab.error = null
      this.saveTab(tab)
      this.emitChanged()
    }
    if (!tab.page) {
      if (tab.error) throw fault('browser_tab_changed', 'the previous Watch page was retired; automatic retargeting is forbidden')
      const page = await this.createPage(tab.worktreeId, tab.profileId, safeUrl(tab.url))
      tab.page = page.browserPageId
      tab.url = safeHistoryAddress(page.url) || tab.url
      tab.title = page.title
      this.saveTab(tab)
      this.emitChanged()
    }
    const page = this.pageFor(tab)
    const watchId = randomUUID()
    const watch: WatchLease = {
      paneId: tab.id,
      watchId,
      pageId: page.browserPageId,
      latest: null,
      sequence: 0,
      lastSentAt: 0
    }
    this.watches.set(tab.id, watch)
    watch.startupTimeout = setTimeout(() => {
      if (this.watches.get(tab.id) === watch && watch.sequence === 0) void this.stopWatch(watch, 'Watch did not receive a frame before its lease timeout.')
    }, WATCH_NO_FRAME_TIMEOUT_MS)
    try {
      await this.runtime.startPaneWatch(page, watchId, {
        onFrame: (frame) => this.receiveFrame(watch, frame),
        onPrompt: (prompt) => this.receivePrompt(watch, prompt),
        onDownloadStart: (download) => this.receiveDownloadStart(watch, page, download),
        onDownloadProgress: (progress) => this.receiveDownloadProgress(watch, progress),
        onLocation: (updated) => this.onPageLocation(watch, updated),
        onPopup: (popup) => this.openPopup(watch, popup),
        onIssue: (reason) => this.watchIssue(watch, reason),
        onStale: (reason) => this.watchEnded(watch, reason)
      })
      if (tab.zoom !== 0) await this.runtime.paneControl(page, { action: 'zoom', level: tab.zoom })
      tab.error = null
      this.saveTab(tab)
      this.emitChanged()
      return { watchId }
    } catch (error) {
      if (this.watches.get(tab.id) === watch) this.watches.delete(tab.id)
      clearTimeout(watch.startupTimeout)
      tab.error = error instanceof Error ? error.message : String(error)
      this.saveTab(tab)
      this.emitChanged()
      throw error
    }
  }

  private async paneWatchStop(request: PaneRequests['paneWatchStop']): Promise<{ closed: true }> {
    const watch = this.watches.get(request.pane)
    if (!watch || watch.watchId !== request.watchId) throw fault('browser_tab_changed', 'the Watch lease ID is stale')
    await this.stopWatch(watch)
    return { closed: true }
  }

  private async paneInput(request: PaneRequests['paneInput']): Promise<{ sent: true }> {
    const tab = this.requirePane(request.pane)
    const watch = this.watches.get(tab.id)
    if (tab.mode !== 'watch' || !tab.page || !watch) throw fault('browser_error', 'typed input is available only for an active Watch page')
    const input = request as PaneRequests['paneInput'] & PaneInput
    await this.runtime.paneInput(this.pageFor(tab), input, watch.watchId)
    return { sent: true }
  }

  private paneFrameAck(params: Record<string, unknown>): { acknowledged: true } {
    const paneId = typeof params.pane === 'string' ? params.pane : ''
    this.requirePane(paneId)
    const watch = this.watches.get(paneId)
    if (!watch || params.watchId !== watch.watchId || typeof params.sequence !== 'number' ||
        !Number.isInteger(params.sequence) || watch.waitingForAck !== params.sequence) {
      throw fault('browser_tab_changed', 'frame acknowledgement belongs to a stale or unacknowledged Watch frame')
    }
    clearTimeout(watch.ackTimeout)
    watch.ackTimeout = undefined
    watch.waitingForAck = undefined
    this.pumpFrame(watch)
    return { acknowledged: true }
  }

  private receiveFrame(watch: WatchLease, frame: { data: string; width: number; height: number }): void {
    if (this.watches.get(watch.paneId) !== watch || Buffer.byteLength(frame.data, 'base64') > 4 * 1024 * 1024) return
    watch.latest = frame
    if (watch.sequence > 0) clearTimeout(watch.startupTimeout)
    this.pumpFrame(watch)
  }

  private pumpFrame(watch: WatchLease): void {
    if (this.watches.get(watch.paneId) !== watch || watch.waitingForAck !== undefined || !watch.latest) return
    const remaining = WATCH_FRAME_INTERVAL_MS - (Date.now() - watch.lastSentAt)
    if (remaining > 0) {
      if (!watch.throttle) watch.throttle = setTimeout(() => {
        watch.throttle = undefined
        this.pumpFrame(watch)
      }, remaining)
      return
    }
    const frame = watch.latest
    watch.latest = null
    const sequence = ++watch.sequence
    watch.waitingForAck = sequence
    watch.lastSentAt = Date.now()
    const event: PaneFrame = { pane: watch.paneId, watchId: watch.watchId, sequence, ...frame }
    if (!this.context.emit('paneFrame', event)) {
      void this.stopWatch(watch, 'No browser pane frame subscriber is connected.')
      return
    }
    watch.ackTimeout = setTimeout(() => {
      if (watch.waitingForAck === sequence) void this.stopWatch(watch, 'Watch stopped because its frame was not acknowledged.')
    }, WATCH_FRAME_ACK_TIMEOUT_MS)
  }

  private async stopWatch(watch: WatchLease, reason?: string): Promise<void> {
    if (this.watches.get(watch.paneId) !== watch) return
    this.watches.delete(watch.paneId)
    clearTimeout(watch.startupTimeout)
    clearTimeout(watch.ackTimeout)
    clearTimeout(watch.throttle)
    watch.latest = null
    try { await this.runtime.stopPaneWatch(watch.watchId) } catch { /* page close and runtime loss already ended this exact lease */ }
    if (reason) this.watchEnded(watch, reason)
  }

  private watchEnded(watch: WatchLease, reason: string): void {
    if (this.watches.get(watch.paneId) === watch) {
      this.watches.delete(watch.paneId)
      clearTimeout(watch.startupTimeout)
      clearTimeout(watch.ackTimeout)
      clearTimeout(watch.throttle)
    }
    const tab = this.tabs.get(watch.paneId)
    if (tab) {
      tab.error = reason
      tab.loading = false
      this.saveTab(tab)
      this.emitChanged()
    }
  }
  private watchIssue(watch: WatchLease, reason: string): void {
    if (this.watches.get(watch.paneId) !== watch) return
    const tab = this.tabs.get(watch.paneId)
    if (!tab) return
    tab.error = reason
    this.saveTab(tab)
    this.emitChanged()
  }

  private async openPopup(
    watch: WatchLease,
    popup: { targetId: string; url: string; windowName: string; hasOpener: boolean; openerFrameId?: string }
  ): Promise<boolean> {
    const opener = this.tabs.get(watch.paneId)
    if (!opener || this.watches.get(watch.paneId) !== watch) return false
    if (popup.hasOpener || (popup.windowName !== '' && popup.windowName !== '_blank')) {
      opener.error = `Popup ${popup.targetId} requires its opener or named OAuth window; URL-only adoption is unsafe.`
      this.saveTab(opener)
      this.emitChanged()
      return false
    }
    let url: string
    try {
      url = safeUrl(popup.url)
      if (!/^https?:/i.test(url)) throw fault('invalid_argument', 'popup URL must be HTTP or HTTPS')
    } catch {
      opener.error = `Popup ${popup.targetId} used an unsupported URL scheme and was blocked.`
      this.saveTab(opener)
      this.emitChanged()
      return false
    }
    let page: BrowserPage | undefined
    try {
      page = await this.createPage(opener.worktreeId, opener.profileId, url)
      await this.paneOpen({
        worktree: `id:${opener.worktreeId}`,
        page: page.browserPageId,
        profile: opener.profileId,
        mode: 'watch'
      }, { role: 'plugin', pluginId: this.context.pluginId })
      return true
    } catch (error) {
      if (page) await this.closeCreatedPage(page.browserPageId)
      opener.error = error instanceof Error ? `Popup could not be hosted: ${error.message}` : 'Popup could not be hosted safely.'
      this.saveTab(opener)
      this.emitChanged()
      return false
    }
  }

  private onPageLocation(watch: WatchLease, page: BrowserPage): void {
    const tab = this.tabs.get(watch.paneId)
    if (!tab || tab.error !== null || this.watches.get(watch.paneId) !== watch) return
    void this.syncFromPage(tab, page).then(() => {
      if (this.watches.get(watch.paneId) !== watch) return
      if (!tab.preview && /^https?:/i.test(tab.url)) this.recordHistory(tab.url, tab.title)
      this.emitChanged()
      if (tab.zoom !== 0) void this.runtime.paneControl(page, { action: 'zoom', level: tab.zoom }).catch(() => {})
    }).catch((error: unknown) => {
      if (this.watches.get(watch.paneId) !== watch) return
      tab.error = error instanceof Error ? error.message : 'managed page location could not be verified'
      this.saveTab(tab)
      this.emitChanged()
    })
  }

  private receivePrompt(watch: WatchLease, prompt: RuntimePanePrompt): void {
    const tab = this.tabs.get(watch.paneId)
    if (!tab || this.watches.get(watch.paneId) !== watch) {
      void prompt.respond({ accept: false }).catch(() => {})
      return
    }
    if (tab.prompts.length > 0) {
      void prompt.respond({ accept: false }).catch(() => {})
      return
    }
    const expiresAt = Date.now() + PROMPT_TIMEOUT_MS
    const visible: PanePrompt = {
      id: prompt.id,
      kind: prompt.kind,
      origin: prompt.origin,
      message: prompt.message.slice(0, 4096),
      ...(prompt.defaultValue === undefined ? {} : { defaultValue: prompt.defaultValue.slice(0, 4096) }),
      ...(prompt.canProceed === undefined ? {} : { canProceed: prompt.canProceed }),
      expiresAt
    }
    const timer = setTimeout(() => {
      const current = this.prompts.get(prompt.id)
      if (!current) return
      void current.prompt.respond({ accept: false }).catch(() => {})
      this.finishPrompt(current)
    }, PROMPT_TIMEOUT_MS)
    this.prompts.set(prompt.id, { paneId: tab.id, watchId: watch.watchId, prompt, timer })
    tab.prompts = [visible]
    this.saveTab(tab)
    this.emitChanged()
  }

  private finishPrompt(prompt: PromptState): void {
    clearTimeout(prompt.timer)
    this.prompts.delete(prompt.prompt.id)
    const tab = this.tabs.get(prompt.paneId)
    if (tab) {
      tab.prompts = tab.prompts.filter((item) => item.id !== prompt.prompt.id)
      this.saveTab(tab)
      this.emitChanged()
    }
  }

  private clearPromptsForPane(paneId: string): void {
    for (const [id, prompt] of this.prompts) {
      if (prompt.paneId !== paneId) continue
      clearTimeout(prompt.timer)
      this.prompts.delete(id)
      void prompt.prompt.respond({ accept: false }).catch(() => {})
    }
    const tab = this.tabs.get(paneId)
    if (tab) tab.prompts = []
  }

  private async paneRespond(request: PaneRequests['paneRespond'], caller: PluginCaller): Promise<{ responded: true }> {
    const prompt = this.prompts.get(request.prompt)
    if (!prompt || prompt.paneId !== request.pane) throw fault('browser_tab_changed', 'prompt ID is stale or belongs to another pane')
    if (prompt.prompt.kind === 'external' && caller.role !== 'ui') throw fault('invalid_argument', 'external-app prompts can only be accepted by the browser UI')
    const input: { accept: boolean; text?: string; username?: string; password?: string } = { accept: request.accept }
    if (request.text !== undefined) {
      if (Buffer.byteLength(request.text, 'utf8') > 4096) throw fault('invalid_argument', 'prompt text exceeds 4,096 UTF-8 bytes')
      input.text = request.text
    }
    if (request.username !== undefined || request.password !== undefined) {
      if (Buffer.byteLength(request.username ?? '', 'utf8') > 1024 || Buffer.byteLength(request.password ?? '', 'utf8') > 1024) {
        throw fault('invalid_argument', 'authentication credentials must each be at most 1,024 UTF-8 bytes')
      }
      input.username = request.username ?? ''
      input.password = request.password ?? ''
    }
    if (prompt.prompt.kind === 'certificate' && request.accept && prompt.prompt.canProceed !== true) {
      this.finishPrompt(prompt)
      await prompt.prompt.respond({ accept: false })
      throw fault('invalid_argument', 'certificate exceptions may only proceed for loopback origins')
    }
    this.finishPrompt(prompt)
    await prompt.prompt.respond(input)
    return { responded: true }
  }

  private receiveDownloadStart(watch: WatchLease, page: BrowserPage, download: { guid: string; url: string; suggestedFilename: string; stagingPath: string }): void {
    const tab = this.tabs.get(watch.paneId)
    if (!tab || this.watches.get(watch.paneId) !== watch) return
    const entry: PaneDownload = {
      id: randomUUID(),
      name: safeFileName(download.suggestedFilename),
      state: 'downloading',
      received: 0
    }
    this.downloads.set(entry.id, {
      paneId: tab.id,
      pageId: page.browserPageId,
      guid: download.guid,
      profileId: page.profileId,
      stagingPath: download.stagingPath,
      entry
    })
    tab.downloads = [...tab.downloads, entry].slice(-MAX_DOWNLOADS_PER_PANE)
    this.saveTab(tab)
    this.emitChanged()
  }

  private receiveDownloadProgress(watch: WatchLease, progress: RuntimePaneDownloadProgress): void {
    let owner: DownloadOwner | undefined
    for (const candidate of this.downloads.values()) {
      if (candidate.pageId === watch.pageId && candidate.guid === progress.guid) {
        owner = candidate
        break
      }
    }
    if (!owner) return
    const entry = owner.entry
    entry.received = Math.max(0, Math.trunc(progress.received))
    if (progress.total !== undefined && Number.isFinite(progress.total)) entry.total = Math.max(0, Math.trunc(progress.total))
    if (progress.state === 'completed') {
      void this.finishDownload(owner)
      return
    }
    if (progress.state === 'canceled') entry.state = 'canceled'
    else if (progress.state === 'paused') entry.state = 'paused'
    else if (progress.state === 'interrupted') {
      entry.state = 'error'
      entry.error = 'Download was interrupted.'
    } else entry.state = 'downloading'
    const tab = this.tabs.get(owner.paneId)
    if (tab?.downloads.some((item) => item.id === entry.id)) {
      this.saveTab(tab)
      this.emitChanged()
    }
    if (progress.state === 'canceled' || progress.state === 'interrupted') this.downloads.delete(entry.id)
  }

  private async finishDownload(owner: DownloadOwner): Promise<void> {
    const entry = owner.entry
    try {
      entry.path = this.publishDownload(owner.stagingPath, owner.profileId, entry.name)
      entry.state = 'completed'
      entry.error = undefined
    } catch (error) {
      entry.state = 'error'
      entry.error = error instanceof Error ? error.message : 'download could not be safely moved'
    }
    this.downloads.delete(entry.id)
    const tab = this.tabs.get(owner.paneId)
    if (tab?.downloads.some((item) => item.id === entry.id)) {
      this.saveTab(tab)
      this.emitChanged()
    }
  }

  private publishDownload(stagingPath: string, profileId: string, requestedName: string): string {
    const stagingDir = realpathSync(join(this.context.dataDir, 'pane-downloads', profileId))
    const source = resolve(stagingPath)
    if (!within(stagingDir, source) || basename(source) === '' || basename(source) === '.' || basename(source) === '..') {
      throw fault('browser_error', 'Chrome download escaped its owned staging directory')
    }
    const sourceInfo = lstatSync(source)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw fault('browser_error', 'Chrome produced a non-regular download artifact')
    const downloads = join(homedir(), 'Downloads')
    mkdirSync(downloads, { recursive: true, mode: 0o700 })
    const destinationRoot = realpathSync(downloads)
    const safeName = safeFileName(requestedName)
    const parsed = parse(safeName)
    for (let index = 0; index < 10_000; index++) {
      const candidateName = index === 0 ? safeName : `${parsed.name} (${index})${parsed.ext}`
      const destination = resolve(destinationRoot, candidateName)
      if (!within(destinationRoot, destination)) throw fault('browser_error', 'download destination escaped the OS Downloads directory')
      try {
        linkSync(source, destination)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') continue
        if (code !== 'EXDEV') throw error
        try { copyFileSync(source, destination, constants.COPYFILE_EXCL) } catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw copyError
        }
      }
      unlinkSync(source)
      return destination
    }
    throw fault('browser_error', 'a collision-free download filename could not be allocated')
  }

  private async paneDownload(request: PaneRequests['paneDownload'], caller: PluginCaller): Promise<{ action: string; completed: true; download?: PaneDownload }> {
    const tab = this.requirePane(request.pane)
    const entry = tab.downloads.find((item) => item.id === request.download)
    if (!entry) throw fault('browser_tab_not_found', 'download does not exist in this pane')
    if (request.action === 'dismiss') {
      tab.downloads = tab.downloads.filter((item) => item.id !== entry.id)
      if (entry.state !== 'downloading' && entry.state !== 'paused') this.downloads.delete(entry.id)
      this.saveTab(tab)
      this.emitChanged()
      return { action: request.action, completed: true }
    }
    if (request.action === 'cancel') {
      if (entry.state !== 'downloading' && entry.state !== 'paused') throw fault('invalid_argument', 'only an active download can be canceled')
      const owner = this.downloads.get(entry.id)
      if (!owner) throw fault('browser_tab_changed', 'download no longer has an active exact-page binding')
      await this.runtime.cancelPaneDownload(owner.pageId, owner.guid)
      entry.state = 'canceled'
      this.downloads.delete(entry.id)
      this.saveTab(tab)
      this.emitChanged()
      return { action: request.action, completed: true, download: structuredClone(entry) }
    }
    if (caller.role !== 'ui' && caller.role !== 'cli') throw fault('invalid_argument', 'opening or revealing a download requires an explicit user action')
    if (entry.state !== 'completed' || !entry.path) throw fault('invalid_argument', 'only a completed owned download can be opened or revealed')
    const path = this.safeDownloadPath(entry.path)
    if (process.platform !== 'darwin') throw fault('browser_unavailable', 'download opening and Finder reveal are supported only on macOS')
    const args = request.action === 'reveal' ? ['open', '-R', path] : ['open', path]
    Bun.spawn(args, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref()
    return { action: request.action, completed: true, download: structuredClone(entry) }
  }

  private safeDownloadPath(path: string): string {
    const root = realpathSync(join(homedir(), 'Downloads'))
    const candidate = realpathSync(path)
    if (!within(root, candidate)) throw fault('invalid_argument', 'download path is outside the OS Downloads directory')
    const info = lstatSync(candidate)
    if (!info.isFile() || info.isSymbolicLink()) throw fault('invalid_argument', 'download is not a regular owned file')
    return candidate
  }

  private pageFor(tab: PaneTab): BrowserPage {
    if (!tab.page) throw fault('browser_no_tab', 'this Watch pane has no managed agent page')
    const page = this.store.getPage(tab.page)
    if (page.worktreeId !== tab.worktreeId || page.profileId !== tab.profileId) {
      throw fault('browser_tab_changed', 'Watch page worktree or browser profile no longer matches its pane')
    }
    return page
  }

  private recordHistory(url: string, title: string): void {
    const address = safeHistoryAddress(url)
    if (address === '' || address === 'about:blank') return
    const previous = this.db.get<{ visited_at: number }>('SELECT MAX(visited_at) AS visited_at FROM browser_pane_history')?.visited_at ?? 0
    const visitedAt = Math.max(Date.now(), previous + 1)
    this.db.transaction(() => {
      this.db.run('DELETE FROM browser_pane_history WHERE url=?', address)
      this.db.run('INSERT INTO browser_pane_history(url, title, visited_at) VALUES(?, ?, ?)', address, title.slice(0, 4096), visitedAt)
      this.db.run('DELETE FROM browser_pane_history WHERE url NOT IN (SELECT url FROM browser_pane_history ORDER BY visited_at DESC LIMIT ?)', HISTORY_LIMIT)
    })
  }

  private history(): PaneState['history'] {
    return this.db.all<{ url: string; title: string; visited_at: number }>(
      'SELECT url, title, visited_at FROM browser_pane_history ORDER BY visited_at DESC LIMIT ?', HISTORY_LIMIT
    ).map((row) => ({ url: row.url, title: row.title, visitedAt: row.visited_at }))
  }


  private emitChanged(): void {
    const tabs = [...this.tabs.values()].sort((a, b) => (this.updatedAt.get(a.id) ?? 0) - (this.updatedAt.get(b.id) ?? 0))
    const active = tabs.filter((tab) => this.activeByWorktree.get(tab.worktreeId) === tab.id)
      .sort((a, b) => (this.updatedAt.get(b.id) ?? 0) - (this.updatedAt.get(a.id) ?? 0))[0]
    this.context.emit('paneChanged', { tabs: tabs.map((tab) => this.copyTab(tab)), active: active?.id ?? null, history: this.history() } satisfies PaneState)
  }
}
