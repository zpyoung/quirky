import { realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { validateValue, type PluginCaller, type PluginContext, type Schema } from '@quirky/protocol'
import { BrowserActions, validateFindParams } from './runtime/actions'
import { BROWSER_METHODS, READ_ONLY_METHODS, type BrowserMethod } from './runtime/catalog'
import { BrowserRuntime } from './runtime/driver'
import { asPluginError, fault } from './runtime/errors'
import { parseExec } from './runtime/exec'
import type { BrowserDependencies } from './runtime/dependencies'
import { BrowserStore } from './profiles/store'
import { CookieImporter } from './cookies/importer'
import { detectBrowsers } from './cookies/sources'
import type { BrowserPage, Cookie, ImportJob } from './cookies/types'

export type BrowserPlugin = { deactivate(): Promise<void> }
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

export class BrowserService {
  private readonly store: BrowserStore
  private readonly runtime: BrowserRuntime
  private readonly actions: BrowserActions
  private readonly importer: CookieImporter
  private identityMode: 'clean' | 'native' = 'clean'
  private active = true
  constructor(private readonly context: PluginContext, private readonly dependencies: BrowserDependencies) {
    this.store = new BrowserStore(context.dataDir)
    this.runtime = new BrowserRuntime(this.store, dependencies, (pageId) => this.actions?.clearPageRefs(pageId))
    this.actions = new BrowserActions(this.store, this.runtime)
    this.importer = new CookieImporter(this.store, this.runtime, dependencies)
  }

  activate(): void {
    for (const name of BROWSER_METHODS) {
      this.context.provide(`method:quirky.browser/${name}`, (params: Record<string, unknown>, caller: PluginCaller) => this.call(name, params, caller))
    }
  }

  async deactivate(): Promise<void> {
    this.active = false
    this.importer.cancelAll()
    await this.runtime.stopAll()
  }

  private async call(name: BrowserMethod, params: Record<string, unknown>, caller: PluginCaller): Promise<unknown> {
    try {
      if (!this.active) throw fault('browser_error', 'browser plugin is shutting down')
      return await this.invoke(name, params, caller)
    } catch (error) {
      throw asPluginError(this.context, error)
    }
  }

  private async invoke(name: BrowserMethod, params: Record<string, unknown>, caller: PluginCaller): Promise<unknown> {
    switch (name) {
      case 'tabList': return this.tabList(params, caller)
      case 'tabShow': return this.tabShow(params)
      case 'tabCurrent': return this.tabCurrent(params, caller)
      case 'tabCreate': return await this.createPage(params, caller)
      case 'tabSwitch': return await this.tabSwitch(params, caller)
      case 'tabClose': return await this.tabClose(params, caller)
      case 'profileList': return { profiles: this.store.listProfiles() }
      case 'profileCreate': return { profile: this.store.createProfile(stringParam(params, 'name'), params.scope === 'imported' ? 'imported' : 'isolated') }
      case 'profileDelete': return await this.profileDelete(stringParam(params, 'profile'))
      case 'profileShow': return this.profileShow(params)
      case 'profileSet': return await this.profileSet(params, caller, stringParam(params, 'profile'))
      case 'profileUseDefault': return await this.profileSet(params, caller, 'default')
      case 'profileClone': return await this.profileClone(params, stringParam(params, 'profile'))
      case 'detectBrowsers': return detectBrowsers(this.dependencies)
      case 'importCookies': return await this.importer.importCookies(optionalString(params, 'profile'), params.source)
      case 'importStart': return this.importer.start(optionalString(params, 'profile'), params.source)
      case 'importGet': return this.importer.get(stringParam(params, 'id'))
      case 'importList': return this.importer.list(optionalString(params, 'profile'), this.importStatus(params.status))
      case 'identityGet': return { mode: this.identityMode, effective: false }
      case 'identitySet':
        this.identityMode = stringParam(params, 'mode') as 'clean' | 'native'
        return { mode: this.identityMode, effective: false }
      case 'openUrl': return await this.createPage({ ...params, profile: 'default' }, caller)
      case 'dialogAccept': return await this.dialog(params, caller, true)
      case 'dialogDismiss': return await this.dialog(params, caller, false)
      case 'exec': return await this.exec(params, caller)
      default: return await this.pageAction(name, params, caller)
    }
  }

  private importStatus(value: unknown): ImportJob['status'] | undefined {
    if (value === undefined) return undefined
    if (value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed') return value
    throw fault('invalid_argument', 'import status is invalid')
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
        await this.runtime.withProfiles([profileId], async () => {
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
    const previous = this.store.listPages().find((item) => item.worktreeId === page.worktreeId && item.active)
    if (previous) this.runtime.invalidatePage(previous.browserPageId, true)
    this.runtime.invalidatePage(page.browserPageId, true)
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
    await this.runtime.closePageOutOfBand(page.browserPageId)
    await this.runtime.withProfiles([page.profileId], async () => {
      await this.runtime.closePageLocked(page.profileId, page.browserPageId)
      this.store.removePage(page.browserPageId)
    })
    return { closed: true }
  }

  private async pageAction(method: BrowserMethod, params: Record<string, unknown>, caller: PluginCaller): Promise<unknown> {
    if (method === 'find') validateFindParams(params)
    if (method === 'goto') validateNavigationUrl(stringParam(params, 'url'))
    const page = await this.resolvePageTarget(params, caller, Object.hasOwn(READ_ONLY_METHODS, method))
    if (method === 'goto' || method === 'back' || method === 'forward' || method === 'reload') this.runtime.invalidatePage(page.browserPageId, true)
    return await this.runtime.withPage(page, method, (execution) => this.actions.run(method, params, execution))
  }

  private async dialog(params: Record<string, unknown>, caller: PluginCaller, accept: boolean) {
    const page = await this.resolvePageTarget(params, caller, false)
    await this.runtime.answerDialog(page.browserPageId, accept, accept ? optionalString(params, 'text', true) : undefined)
    return accept ? { accepted: true } : { dismissed: true }
  }

  private async profileShow(params: Record<string, unknown>) {
    const page = this.store.getPage(stringParam(params, 'page'))
    const profile = this.store.getProfile(page.profileId)
    return { browserPageId: page.browserPageId, worktreeId: page.worktreeId, profileId: profile.id, profileLabel: profile.label }
  }

  private async profileSet(params: Record<string, unknown>, caller: PluginCaller, profileId: string) {
    const page = await this.resolvePageTarget(params, caller, false)
    this.store.getProfile(profileId)
    if (page.profileId === profileId) {
      const profile = this.store.getProfile(profileId)
      return { browserPageId: page.browserPageId, profileId, profileLabel: profile.label }
    }
    const oldProfileId = page.profileId
    await this.runtime.cancelPageForChange(page.browserPageId)
    try {
      await this.runtime.withProfiles([oldProfileId, profileId], async () => {
        await this.runtime.rebindPageLocked(oldProfileId, page.browserPageId)
        const changed = this.store.setPageProfile(page.browserPageId, profileId)
        await this.runtime.ensurePageLocked(changed)
      })
    } finally {
      this.runtime.finishPageChange(page.browserPageId)
    }
    const profile = this.store.getProfile(profileId)
    return { browserPageId: page.browserPageId, profileId, profileLabel: profile.label }
  }

  private async profileDelete(profileId: string) {
    if (profileId === 'default') throw fault('invalid_argument', 'the Default profile cannot be deleted')
    const profile = this.store.getProfile(profileId)
    const pages = this.store.listPages().filter((page) => page.profileId === profileId)
    for (const page of pages) await this.runtime.cancelPageForChange(page.browserPageId)
    try {
      await this.runtime.withProfiles([profileId, 'default'], async () => {
        for (const page of pages) {
          await this.runtime.rebindPageLocked(profileId, page.browserPageId)
          const moved = this.store.setPageProfile(page.browserPageId, 'default')
          await this.runtime.ensurePageLocked(moved)
        }
        this.store.deleteProfile(profileId)
        await this.runtime.stopProfileLocked(profileId)
        this.store.removeProfileData(profileId)
      })
    } finally {
      for (const page of pages) this.runtime.finishPageChange(page.browserPageId)
    }
    return { deleted: true, profileId }
  }

  private async profileClone(params: Record<string, unknown>, destinationId: string) {
    const destination = this.store.getProfile(destinationId)
    if (destination.scope !== 'isolated') throw fault('invalid_argument', 'profile clone destination must be an isolated profile')
    const sourceId = stringParam(params, 'source')
    const sourcePage = this.store.getPage(sourceId)
    if (this.store.listPages().some((page) => page.profileId === destinationId)) throw fault('invalid_argument', 'profile clone destination must be empty')
    return await this.runtime.withProfiles([sourcePage.profileId, destinationId], async () => {
      const sourceTransport = await this.runtime.cookieTransportLocked(sourcePage.profileId)
      const destinationTransport = await this.runtime.cookieTransportLocked(destinationId)
      const destinationCookies = await destinationTransport.list(destinationId)
      if (destinationCookies.length > 0) throw fault('invalid_argument', 'profile clone destination must not contain cookies')
      const sourceCookies = await sourceTransport.list(sourcePage.profileId)
      const copied: Cookie[] = []
      try {
        for (const cookie of sourceCookies) {
          copied.push(cookie)
          await destinationTransport.set(destinationId, cookie)
        }
      } catch {
        let rollbackFailed = false
        for (const cookie of copied) {
          try { await destinationTransport.delete(destinationId, cookie) } catch { rollbackFailed = true }
        }
        if (rollbackFailed) throw fault('browser_unsafe_replace', 'profile clone failed and destination cookies could not be rolled back')
        throw fault('browser_error', 'profile cookie clone failed')
      }
      const page = this.store.addPage({ worktreeId: sourcePage.worktreeId, profileId: destinationId, url: sourcePage.url, title: sourcePage.title, active: false })
      try {
        await this.runtime.ensurePageLocked(page)
      } catch (error) {
        this.store.removePage(page.browserPageId)
        let rollbackFailed = false
        for (const cookie of copied) {
          try { await destinationTransport.delete(destinationId, cookie) } catch { rollbackFailed = true }
        }
        if (rollbackFailed) throw fault('browser_unsafe_replace', 'profile clone page creation failed and destination cookies could not be rolled back')
        throw error
      }
      return { browserPageId: page.browserPageId, sourceBrowserPageId: sourceId, profileId: destinationId, profileLabel: destination.label }
    })
  }

  private async exec(params: Record<string, unknown>, caller: PluginCaller) {
    const plan = parseExec(stringParam(params, 'command'))
    if (plan.method === 'find') validateFindParams(plan.params)
    if (plan.method === 'goto') validateNavigationUrl(stringParam(plan.params, 'url'))
    const page = await this.resolvePageTarget(params, caller, false)
    if (plan.method === 'dialogAccept' || plan.method === 'dialogDismiss') {
      const result = await this.runtime.answerDialog(page.browserPageId, plan.method === 'dialogAccept', typeof plan.params.text === 'string' ? plan.params.text : undefined)
      return { command: plan.command, result: plan.method === 'dialogAccept' ? { accepted: true } : { dismissed: true } }
    }
    if (plan.method === 'goto' || plan.method === 'back' || plan.method === 'forward' || plan.method === 'reload') this.runtime.invalidatePage(page.browserPageId, true)
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

