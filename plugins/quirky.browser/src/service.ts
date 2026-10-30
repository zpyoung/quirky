import { realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { validateValue, type PluginCaller, type PluginContext, type Schema } from '@quirky/protocol'
import { BrowserActions } from './runtime/actions'
import { BROWSER_METHODS, READ_ONLY_METHODS, type BrowserMethod } from './runtime/catalog'
import { BrowserRuntime } from './runtime/driver'
import { asPluginError, fault } from './runtime/errors'
import { parseExec } from './runtime/exec'
import type { BrowserDependencies } from './runtime/dependencies'
import { CookieImporter } from './cookies/importer'
import { detectBrowsers } from './cookies/sources'
import type { BrowserFamily, ImportJob, ImportSource } from './cookies/types'
import { BrowserStore, type BrowserPage } from './profiles/store'
import { DESIGN_METHODS, type DesignMethod, type DesignRequests } from './design-contract'
import { DesignService } from './design/service'
import { ProfileLifecycle } from './preferences-lifecycle'
import { registerPreferences } from './preferences/controller'
import { identityModeFromSetting } from './preferences/identity'
import type { PreferencesController } from './preferences/contract'
import { PANE_METHODS, type PaneMethod, type PaneTab } from './pane-contract'
import { PaneService } from './pane-service'

export type BrowserPlugin = {
  deactivate(): Promise<void>
  setPaneProfile(paneId: string, profileId: string): Promise<PaneTab>
  listPanes(): PaneTab[]
}
type Worktree = { id: string; name: string; path: string; branch?: unknown }

const WORKTREE_LIST_SCHEMA: Schema = {
  type: 'array',
  items: {
    type: 'object',
    properties: { id: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, branch: {} },
    required: ['id', 'name', 'path', 'branch'],
    additionalProperties: true
  }
}

function stringParam(params: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = params[key]
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw fault('invalid_argument', `${key} must be a ${allowEmpty ? 'string' : 'non-empty string'}`)
  return value
}

function optionalString(params: Record<string, unknown>, key: string, allowEmpty = false): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw fault('invalid_argument', `${key} must be a ${allowEmpty ? 'string' : 'non-empty string'}`)
  }
  return value
}

function canonicalPath(value: string): string {
  if (!isAbsolute(value)) throw fault('invalid_argument', 'cwd and path selectors must be absolute paths')
  try { return realpathSync(value) } catch { return resolve(value) }
}

function containsPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function pageProjection(page: BrowserPage): BrowserPage {
  return {
    browserPageId: page.browserPageId,
    worktreeId: page.worktreeId,
    profileId: page.profileId,
    index: page.index,
    active: page.active,
    url: page.url,
    title: page.title,
    loadError: page.loadError
  }
}

function isAllowedNavigation(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:'
  } catch {
    return false
  }
}
function validateNavigationUrl(url: string): void {
  if (!isAllowedNavigation(url)) throw fault('invalid_argument', 'URL must be absolute HTTP, HTTPS, file, or exactly about:blank')
}

const BROWSER_FAMILIES = ['chrome', 'edge', 'arc', 'chromium', 'comet', 'helium', 'firefox', 'safari'] as const satisfies readonly BrowserFamily[]
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}


function parseImportSource(value: unknown): ImportSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fault('invalid_argument', 'source must be an explicit cookie source')
  const source = value as Record<string, unknown>
  if (source.kind === 'json') {
    if (!Array.isArray(source.cookies) || !hasOnlyKeys(source, ['kind', 'cookies'])) {
      throw fault('invalid_argument', 'JSON cookie source must contain only a cookies array')
    }
    return { kind: 'json', cookies: source.cookies }
  }
  if (source.kind === 'file') {
    const path = source.path
    if (!hasOnlyKeys(source, ['kind', 'path']) || typeof path !== 'string' || !isAbsolute(path)) {
      throw fault('invalid_argument', 'file cookie source must contain an absolute path only')
    }
    return { kind: 'file', path }
  }
  if (source.kind === 'browser') {
    const family = source.family
    if (!hasOnlyKeys(source, ['kind', 'family', 'profile']) ||
      typeof family !== 'string' || !BROWSER_FAMILIES.includes(family as BrowserFamily)) {
      throw fault('invalid_argument', 'browser cookie source family is not supported')
    }
    const profile = source.profile
    if (profile !== undefined && (typeof profile !== 'string' || profile.length === 0)) {
      throw fault('invalid_argument', 'source profile must be a non-empty string')
    }
    return { kind: 'browser', family: family as BrowserFamily, ...(typeof profile === 'string' ? { profile } : {}) }
  }
  throw fault('invalid_argument', 'source must be an explicit file, JSON, or browser cookie source')
}

function identityMode(value: unknown): 'clean' | 'native' {
  if (value !== 'clean' && value !== 'native') throw fault('invalid_argument', 'mode must be clean or native')
  return value
}

const IDENTITY_SETTING_ID = 'setting:quirky.browser/identityMode'

function identityState(selected: unknown, active: 'clean' | 'native') {
  const mode = identityModeFromSetting(selected)
  return { mode, active, restartRequired: mode !== active }
}

function importStatus(value: unknown): ImportJob['status'] | undefined {
  if (value === undefined) return undefined
  if (value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed') return value
  throw fault('invalid_argument', 'import status is invalid')
}

export class BrowserService {
  private readonly store: BrowserStore
  private readonly runtime: BrowserRuntime
  private readonly actions: BrowserActions
  private readonly importer: CookieImporter
  private readonly activeIdentityMode: 'clean' | 'native'
  private readonly profileLifecycle: ProfileLifecycle
  private preferences?: PreferencesController
  private readonly panes: PaneService
  private readonly design: DesignService
  private active = true
  constructor(private readonly context: PluginContext, private readonly dependencies: BrowserDependencies) {
    this.store = new BrowserStore(context.dataDir)
    this.activeIdentityMode = identityModeFromSetting(context.getSetting('identityMode'))
    this.runtime = new BrowserRuntime(this.store, dependencies, (pageId) => this.actions?.clearPageRefs(pageId), this.activeIdentityMode)
    this.actions = new BrowserActions(this.store, this.runtime)
    this.importer = new CookieImporter(this.store, this.runtime, this.dependencies)
    this.profileLifecycle = new ProfileLifecycle(context, this.store, this.runtime, () => this.listPanes())
    this.panes = new PaneService(
      context,
      this.store,
      this.runtime,
      (selector, caller, allowNoScope) => this.resolveWorktreeTarget(selector, undefined, caller, allowNoScope),
      () => this.listWorktrees(),
      this.dependencies.downloadDirectory,
      this.dependencies.promptTimeoutMs
    )
    this.design = new DesignService(context, this.runtime, () => this.panes.listPanes(), (pageId) => this.store.getPage(pageId))
  }
  activate(): void {
    for (const name of BROWSER_METHODS) {
      this.context.provide(`method:quirky.browser/${name}`, (params: Record<string, unknown>, caller: PluginCaller) => this.call(name, params, caller))
    }
    this.profileLifecycle.activate()
    this.preferences = registerPreferences(this.context, {
      listProfiles: () => this.store.listProfiles(),
      listPanes: () => this.listPanes(),
      listPageProfiles: () => this.store.listPages().map((page) => page.profileId),
      setPaneProfile: (pane, profile) => this.setPaneProfile(pane, profile),
      clearProfile: (profile, remove) => this.profileLifecycle.clearProfile(profile, remove),
      nativeIdentitySupported: process.platform === 'darwin'
    })
  }
  async setPaneProfile(paneId: string, profileId: string): Promise<PaneTab> {
    return await this.profileLifecycle.withProfileAdmission(profileId, async () => {
      const current = this.panes.listPanes().find((tab) => tab.id === paneId)
      if (current && current.profileId !== profileId) await this.design.cancelPane(paneId)
      return await this.panes.setPaneProfile(paneId, profileId)
    })
  }

  listPanes(): PaneTab[] {
    return this.panes.listPanes()
  }

  async deactivate(): Promise<void> {
    this.active = false
    this.preferences?.deactivate()
    this.profileLifecycle.deactivate()
    await this.importer.cancelAll()
    await this.design.deactivate()
    await this.panes.deactivate()
    await this.runtime.stopAll()
  }

  private async call(name: BrowserMethod, params: Record<string, unknown>, caller: PluginCaller): Promise<unknown> {
    try {
      if (!this.active) throw fault('browser_error', 'browser plugin is shutting down')
      const result = await this.invoke(name, params, caller)
      if (name === 'tabCreate' || name === 'tabClose' || name === 'profileCreate' || name === 'paneOpen' || name === 'paneClose' ||
        name === 'tabProfileSet' || name === 'tabProfileUseDefault' || name === 'profileClone' || name === 'importCookies' || name === 'identitySet' || name === 'openUrl') {
        this.context.emit('preferencesChanged', {})
      }
      return result
    } catch (error) {
      throw asPluginError(this.context, error)
    }
  }

  private async invoke(name: BrowserMethod, params: Record<string, unknown>, caller: PluginCaller): Promise<unknown> {
    if (name === 'paneOpen') {
      const pageId = optionalString(params, 'page')
      const profileId = pageId === undefined ? optionalString(params, 'profile') ?? 'default' : this.store.getPage(pageId).profileId
      return await this.profileLifecycle.withProfileAdmission(profileId, () => this.panes.call('paneOpen', params, caller))
    }
    if ((PANE_METHODS as readonly string[]).includes(name)) {
      const result = await this.panes.call(name as PaneMethod, params, caller)
      if (name === 'paneClose' || name === 'paneWatchStop' || name === 'paneNavigate' || name === 'panePreview') {
        const pane = typeof params.pane === 'string' ? params.pane : ''
        if (pane !== '') await this.design.cancelPane(pane)
      }
      return result
    }
    if ((DESIGN_METHODS as readonly string[]).includes(name)) {
      const paneId = optionalString(params, 'pane')
      if (paneId) this.panes.assertDefaultWatchOwner(paneId)
      return await this.designMethod(name as DesignMethod, params)
    }
    switch (name) {
      case 'tabList': return this.tabList(params, caller)
      case 'tabShow': return this.tabShow(params)
      case 'tabCurrent': return this.tabCurrent(params, caller)
      case 'tabCreate': return await this.profileLifecycle.withProfileAdmission(optionalString(params, 'profile') ?? 'default', () => this.createPage(params, caller))
      case 'tabSwitch': return await this.tabSwitch(params, caller)
      case 'tabClose': return await this.tabClose(params, caller)
      case 'profileList': return { profiles: this.store.listProfiles() }
      case 'profileCreate': return { profile: this.store.createProfile(stringParam(params, 'name')) }
      case 'tabProfileShow': return await this.tabProfileShow(params, caller)
      case 'tabProfileSet': return await this.setPageProfile(params, caller, stringParam(params, 'profile'))
      case 'tabProfileUseDefault': return await this.setPageProfile(params, caller, 'default')
      case 'profileClone': return await this.profileClone(params)
      case 'detectBrowsers': return await detectBrowsers(this.dependencies)
      case 'importCookies': return await this.importer.importCookies(optionalString(params, 'profile'), parseImportSource(params.source))
      case 'importStart': return this.importer.start(optionalString(params, 'profile'), parseImportSource(params.source))
      case 'importGet': return this.importer.get(stringParam(params, 'id'))
      case 'importList': return this.importer.list(optionalString(params, 'profile'), importStatus(params.status))
      case 'identityGet': return identityState(this.context.getSetting('identityMode'), this.activeIdentityMode)
      case 'identitySet': {
        const mode = identityMode(params.mode)
        await this.context.call('setting.set', { id: IDENTITY_SETTING_ID, value: mode })
        return identityState(mode, this.activeIdentityMode)
      }
      case 'openUrl': return await this.profileLifecycle.withProfileAdmission('default', () => this.createPage({ ...params, profile: 'default' }, caller))
      case 'dialogAccept': return await this.dialog(params, caller, true)
      case 'dialogDismiss': return await this.dialog(params, caller, false)
      case 'exec': return await this.exec(params, caller)
      default: return await this.pageAction(name, params, caller)
    }
  }

  private async tabProfileShow(params: Record<string, unknown>, caller: PluginCaller) {
    const page = await this.resolvePageTarget(params, caller, false)
    const profile = this.store.getProfile(page.profileId)
    return { browserPageId: page.browserPageId, worktreeId: page.worktreeId, profileId: profile.id, profileLabel: profile.label }
  }

  private async setPageProfile(params: Record<string, unknown>, caller: PluginCaller, profileId: string) {
    this.store.getProfile(profileId)
    const page = await this.resolvePageTarget(params, caller, false)
    const updated = await this.runtime.setPageProfile(page, profileId)
    const profile = this.store.getProfile(updated.profileId)
    return { browserPageId: updated.browserPageId, profileId: profile.id, profileLabel: profile.label }
  }

  private async profileClone(params: Record<string, unknown>) {
    const sourcePageId = stringParam(params, 'source')
    const source = this.store.getPage(sourcePageId)
    const destinationId = stringParam(params, 'profile')
    const page = await this.runtime.clonePageProfile(source, destinationId)
    const profile = this.store.getProfile(page.profileId)
    return {
      browserPageId: page.browserPageId,
      sourceBrowserPageId: sourcePageId,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }

  private async dialog(params: Record<string, unknown>, caller: PluginCaller, accept: boolean) {
    const page = await this.resolvePageTarget(params, caller, false)
    const text = accept ? optionalString(params, 'text', true) : undefined
    await this.runtime.answerDialog(page.browserPageId, accept, text)
    return accept ? { accepted: true } : { dismissed: true }
  }

  private async designMethod(method: DesignMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'designArm': return await this.design.designArm(params as DesignRequests['designArm'])
      case 'designRead': return await this.design.designRead(params as DesignRequests['designRead'])
      case 'designHover': return await this.design.designHover(params as DesignRequests['designHover'])
      case 'designCancel': return await this.design.designCancel(params as DesignRequests['designCancel'])
      case 'designCapture': return await this.design.designCapture(params as DesignRequests['designCapture'])
      case 'designFormat': return await this.design.designFormat(params as DesignRequests['designFormat'])
      case 'designTargets': return await this.design.designTargets(params as DesignRequests['designTargets'])
      case 'designSend': return await this.design.designSend(params as DesignRequests['designSend'])
      default: throw fault('browser_error', `no design implementation exists for ${method}`)
    }
  }


  private async tabList(params: Record<string, unknown>, caller: PluginCaller) {
    const selector = optionalString(params, 'worktree')
    const cwd = optionalString(params, 'cwd')
    if (selector === 'all') return { tabs: this.store.listPages().map(pageProjection) }
    const worktreeId = await this.resolveWorktreeTarget(selector, cwd, caller, true)
    const pages = this.store.listPages().filter((page) => worktreeId === undefined || page.worktreeId === worktreeId)
    return { tabs: pages.map(pageProjection) }
  }

  private tabShow(params: Record<string, unknown>) {
    const page = this.store.getPage(stringParam(params, 'page'))
    return { tab: pageProjection(page) }
  }

  private async tabCurrent(params: Record<string, unknown>, caller: PluginCaller) {
    const selector = optionalString(params, 'worktree')
    if (selector === 'all') {
      const page = this.globalActivePage()
      return { tab: pageProjection(page) }
    }
    const worktreeId = await this.resolveWorktreeTarget(selector, optionalString(params, 'cwd'), caller, true)
    if (worktreeId === undefined) return { tab: pageProjection(this.globalActivePage()) }
    const page = this.activePage(this.store.listPages().filter((item) => item.worktreeId === worktreeId))
    return { tab: pageProjection(page) }
  }

  private async createPage(params: Record<string, unknown>, caller: PluginCaller): Promise<{ browserPageId: string }> {
    const url = optionalString(params, 'url') ?? 'about:blank'
    validateNavigationUrl(url)
    const worktreeId = await this.resolveWorktreeTarget(optionalString(params, 'worktree'), optionalString(params, 'cwd'), caller, false)
    const profileId = optionalString(params, 'profile') ?? 'default'
    this.store.getProfile(profileId)
    this.profileLifecycle.assertAvailable(profileId)
    const page = this.store.addPage({ worktreeId: worktreeId ?? null, profileId, url: 'about:blank', title: '' })
    try {
      await this.runtime.withPage(page, 'tabCreate', async (execution) => {
        if (url !== 'about:blank') return await this.actions.run('goto', { url }, execution)
        const location = await this.runtime.pageLocation(execution)
        this.store.updatePage(page.browserPageId, (record) => { record.title = location.title })
        return location
      })
      return { browserPageId: page.browserPageId }
    } catch (error) {
      try { await this.runtime.closePageOutOfBand(page.browserPageId) } catch { /* preserve the launch failure */ }
      try {
        await this.runtime.withProfileLock(profileId, async () => {
          await this.runtime.closePageLocked(profileId, page.browserPageId)
          this.store.removePage(page.browserPageId)
        })
      } catch { this.store.removePage(page.browserPageId) }
      throw error
    }
  }

  private async tabSwitch(params: Record<string, unknown>, caller: PluginCaller) {
    const pageParam = optionalString(params, 'page')
    const indexParam = params.index
    if ((pageParam === undefined) === (indexParam === undefined)) throw fault('invalid_argument', 'tab switch requires exactly one of page or index')
    if (params.focus === true) throw fault('invalid_argument', 'Visible pane focus belongs to browser UI; automation is headless.')
    let page: BrowserPage
    if (pageParam !== undefined) {
      page = this.store.getPage(pageParam)
    } else {
      if (typeof indexParam !== 'number' || !Number.isInteger(indexParam) || indexParam < 0) throw fault('invalid_argument', 'tab index must be a non-negative integer')
      const worktreeId = await this.resolveWorktreeTarget(optionalString(params, 'worktree'), optionalString(params, 'cwd'), caller, false)
      const candidates = this.store.listPages().filter((item) => item.worktreeId === worktreeId)
      page = candidates[indexParam] ?? (() => { throw fault('browser_tab_not_found', `tab index ${indexParam} does not exist`) })()
    }
    await this.runtime.withPage(page, 'tabSwitch', async () => {
      this.store.switchPage(page.browserPageId)
      return undefined
    })
    return { switched: page.index, browserPageId: page.browserPageId }
  }

  private async tabClose(params: Record<string, unknown>, caller: PluginCaller) {
    const pageParam = optionalString(params, 'page')
    const index = params.index
    let page: BrowserPage
    if (pageParam !== undefined) page = this.store.getPage(pageParam)
    else {
      const worktreeId = await this.resolveWorktreeTarget(optionalString(params, 'worktree'), optionalString(params, 'cwd'), caller, false)
      const candidates = this.store.listPages().filter((item) => item.worktreeId === worktreeId)
      if (typeof index === 'number') {
        if (!Number.isInteger(index) || index < 0) throw fault('invalid_argument', 'tab index must be a non-negative integer')
        page = candidates[index] ?? (() => { throw fault('browser_tab_not_found', `tab index ${index} does not exist`) })()
      } else page = this.activePage(candidates)
    }
    await this.design.cancelPage(page.browserPageId)
    await this.runtime.closePageOutOfBand(page.browserPageId)
    await this.runtime.withProfileLock(page.profileId, async () => {
      await this.runtime.closePageLocked(page.profileId, page.browserPageId)
      this.store.removePage(page.browserPageId)
    })
    return { closed: true }
  }

  private async pageAction(method: BrowserMethod, params: Record<string, unknown>, caller: PluginCaller): Promise<unknown> {
    if (method === 'goto') validateNavigationUrl(stringParam(params, 'url'))
    const page = await this.resolvePageTarget(params, caller, Object.hasOwn(READ_ONLY_METHODS, method))
    if (method === 'goto' || method === 'back' || method === 'forward' || method === 'reload') {
      await this.design.cancelPage(page.browserPageId)
      this.runtime.invalidatePage(page.browserPageId, true)
    }
    return await this.runtime.withPage(page, method, (execution) => this.actions.run(method, params, execution))
  }


  private async exec(params: Record<string, unknown>, caller: PluginCaller) {
    const plan = parseExec(stringParam(params, 'command'))
    if (plan.method === 'goto') validateNavigationUrl(stringParam(plan.params, 'url'))
    const page = await this.resolvePageTarget(params, caller, false)
    if (plan.method === 'dialogAccept' || plan.method === 'dialogDismiss') {
      const accept = plan.method === 'dialogAccept'
      const text = accept ? optionalString(plan.params, 'text', true) : undefined
      await this.runtime.answerDialog(page.browserPageId, accept, text)
      return { command: plan.command, result: accept ? { accepted: true } : { dismissed: true } }
    }
    if (plan.method === 'goto' || plan.method === 'back' || plan.method === 'forward' || plan.method === 'reload') {
      await this.design.cancelPage(page.browserPageId)
      this.runtime.invalidatePage(page.browserPageId, true)
    }
    const result = await this.runtime.withPage(page, 'exec', (execution) => this.actions.run(plan.method, plan.params, execution))
    return { command: plan.command, result }
  }

  private async resolvePageTarget(params: Record<string, unknown>, caller: PluginCaller, allowGlobalActive: boolean): Promise<BrowserPage> {
    const pageId = optionalString(params, 'page')
    if (pageId !== undefined) return this.store.getPage(pageId)
    const selector = optionalString(params, 'worktree')
    const cwd = optionalString(params, 'cwd')
    const worktreeId = await this.resolveWorktreeTarget(selector, cwd, caller, allowGlobalActive)
    if (worktreeId === 'all') throw fault('invalid_argument', 'worktree all is not a concrete browser page target')
    if (worktreeId !== undefined) return this.activePage(this.store.listPages().filter((page) => page.worktreeId === worktreeId))
    if (!allowGlobalActive) throw fault('browser_no_tab', 'a page or worktree target is required for browser mutations')
    return this.globalActivePage()
  }

  private activePage(pages: BrowserPage[]): BrowserPage {
    if (pages.length === 0) throw fault('browser_no_tab', 'no managed browser page exists for the requested worktree')
    const active = pages.filter((page) => page.active)
    if (active.length === 1) return active[0]!
    if (pages.length === 1) return pages[0]!
    throw fault('browser_no_tab', 'the requested worktree has no unique active managed page')
  }

  private globalActivePage(): BrowserPage {
    const pages = this.store.listPages()
    if (pages.length === 0) throw fault('browser_no_tab', 'no managed browser page exists')
    const active = pages.filter((page) => page.active)
    if (active.length === 1) return active[0]!
    if (pages.length === 1) return pages[0]!
    throw fault('browser_no_tab', 'no unique global active managed page exists; select a page or worktree')
  }

  private async resolveWorktreeTarget(
    selector: string | undefined,
    cwd: string | undefined,
    caller: PluginCaller,
    allowNoScope: boolean
  ): Promise<string | 'all' | undefined> {
    if (selector === 'all') {
      if (!allowNoScope) throw fault('invalid_argument', 'worktree all is only valid for read-only list operations')
      return 'all'
    }
    if (selector === 'floating' || selector === 'id:floating') {
      // Explicit floating scope is an owned terminal destination, never ambient cwd inference.
      await this.context.call('quirky.terminal/workspace', { workspace: 'floating' })
      return 'floating'
    }
    const worktrees = await this.listWorktrees()
    if (selector === undefined) {
      if (cwd !== undefined) return this.worktreeContaining(worktrees, canonicalPath(cwd)).id
      if (!allowNoScope) return undefined
      return undefined
    }
    const text = selector.trim()
    if (text === '') throw fault('invalid_argument', 'worktree selector must not be empty')
    if (text === 'current' || text === 'active') {
      if (caller.role !== 'plugin' && caller.worktreeId) {
        const current = worktrees.find((worktree) => worktree.id === caller.worktreeId)
        if (current) return current.id
      }
      if (cwd !== undefined) return this.worktreeContaining(worktrees, canonicalPath(cwd)).id
      if (caller.role !== 'plugin' && caller.cwd) return this.worktreeContaining(worktrees, canonicalPath(caller.cwd)).id
      throw fault('browser_tab_not_found', 'current worktree could not be resolved from this caller')
    }
    const prefix = /^(id|name|branch|path):(.*)$/s.exec(text)
    let matches: Worktree[]
    if (prefix) {
      const kind = prefix[1]!
      const value = prefix[2]!
      if (value === '') throw fault('invalid_argument', `${kind}: selector requires a value`)
      if (kind === 'id') matches = worktrees.filter((worktree) => worktree.id === value)
      else if (kind === 'name') matches = this.namedWorktrees(worktrees, value)
      else if (kind === 'branch') matches = worktrees.filter((worktree) => worktree.branch === value)
      else {
        const base = cwd ?? (caller.role === 'plugin' ? undefined : caller.cwd)
        if (!isAbsolute(value) && base === undefined) throw fault('invalid_argument', 'relative path: selectors require a caller cwd')
        const targetPath = canonicalPath(isAbsolute(value) ? value : join(base ?? '/', value))
        matches = [this.worktreeContaining(worktrees, targetPath)]
      }
    } else {
      const ids = worktrees.filter((worktree) => worktree.id === text)
      const names = ids.length > 0 ? ids : this.namedWorktrees(worktrees, text)
      matches = names.length > 0 ? names : worktrees.filter((worktree) => worktree.branch === text)
    }
    if (matches.length === 0) throw fault('browser_tab_not_found', `no worktree matches ${selector}`)
    if (matches.length > 1) throw fault('invalid_argument', `worktree selector ${selector} is ambiguous`)
    return matches[0]!.id
  }

  private namedWorktrees(worktrees: Worktree[], name: string): Worktree[] {
    const byName = worktrees.filter((worktree) => worktree.name === name)
    return byName.length > 0 ? byName : worktrees.filter((worktree) => basename(worktree.path) === name)
  }

  private worktreeContaining(worktrees: Worktree[], candidate: string): Worktree {
    let match: Worktree | undefined
    let matchLength = -1
    for (const worktree of worktrees) {
      const root = canonicalPath(worktree.path)
      if (containsPath(root, candidate) && root.length > matchLength) {
        match = worktree
        matchLength = root.length
      }
    }
    if (!match) throw fault('browser_tab_not_found', `no worktree contains the requested path`)
    return match
  }

  private async listWorktrees(): Promise<Worktree[]> {
    let value: unknown
    try { value = await this.context.call('quirky.worktree/list', {}) } catch {
      throw fault('browser_error', 'worktree resolution requires the public quirky.worktree/list method')
    }
    if (validateValue(WORKTREE_LIST_SCHEMA, value, 'worktree list')) throw fault('browser_error', 'worktree plugin returned an invalid list result')
    return value as Worktree[]
  }
}

