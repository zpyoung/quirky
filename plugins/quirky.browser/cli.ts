import { resolve } from 'node:path'
import { validateValue, type CliArgs, type CliContext, type CliModule, type Schema } from '@quirky/protocol'
import type { BrowserMethod } from './src/runtime/catalog'

const COMMAND_METHODS: Readonly<Record<string, BrowserMethod>> = {
  tabList: 'tabList', tabShow: 'tabShow', tabCurrent: 'tabCurrent', tabCreate: 'tabCreate', tabSwitch: 'tabSwitch', tabClose: 'tabClose',
  snapshot: 'snapshot', screenshot: 'screenshot', fullScreenshot: 'fullScreenshot', pdf: 'pdf', goto: 'goto', back: 'back', forward: 'forward', reload: 'reload',
  click: 'click', dblclick: 'dblclick', fill: 'fill', type: 'type', keyboardInsertText: 'keyboardInsertText', keypress: 'keypress', select: 'select',
  check: 'check', uncheck: 'uncheck', focus: 'focus', hover: 'hover', scrollIntoView: 'scrollIntoView', clear: 'clear', selectAll: 'selectAll',
  drag: 'drag', upload: 'upload', scroll: 'scroll', wait: 'wait', eval: 'eval', get: 'get', is: 'is', find: 'find', mouseMove: 'mouseMove',
  mouseDown: 'mouseDown', mouseUp: 'mouseUp', mouseWheel: 'mouseWheel', highlight: 'highlight', download: 'download', console: 'console', network: 'network',
  captureStart: 'captureStart', captureStop: 'captureStop', interceptEnable: 'interceptEnable', interceptDisable: 'interceptDisable', interceptList: 'interceptList',
  cookieGet: 'cookieGet', cookieSet: 'cookieSet', cookieDelete: 'cookieDelete', storageLocalGet: 'storageLocalGet', storageLocalSet: 'storageLocalSet',
  storageLocalClear: 'storageLocalClear', storageSessionGet: 'storageSessionGet', storageSessionSet: 'storageSessionSet', storageSessionClear: 'storageSessionClear',
  viewport: 'viewport', geolocation: 'geolocation', setDevice: 'setDevice', setOffline: 'setOffline', setHeaders: 'setHeaders', setCredentials: 'setCredentials',
  setMedia: 'setMedia', clipboardRead: 'clipboardRead', clipboardWrite: 'clipboardWrite', dialogAccept: 'dialogAccept', dialogDismiss: 'dialogDismiss',
  profileList: 'profileList', profileCreate: 'profileCreate', profileDelete: 'profileDelete', profileShow: 'profileShow', profileSet: 'profileSet',
  profileUseDefault: 'profileUseDefault', profileClone: 'profileClone', detectBrowsers: 'detectBrowsers', importGet: 'importGet', importList: 'importList',
  identityGet: 'identityGet', identitySet: 'identitySet', openUrl: 'openUrl', exec: 'exec'
}

const PAGE_TARGET_COMMANDS: Readonly<Record<string, true>> = {
  tabList: true, tabShow: true, tabCurrent: true, tabCreate: true, tabSwitch: true, tabClose: true,
  snapshot: true, screenshot: true, fullScreenshot: true, pdf: true, goto: true, back: true, forward: true, reload: true,
  click: true, dblclick: true, fill: true, type: true, keyboardInsertText: true, keypress: true, select: true, check: true, uncheck: true,
  focus: true, hover: true, scrollIntoView: true, clear: true, selectAll: true, drag: true, upload: true, scroll: true, wait: true, eval: true,
  get: true, is: true, find: true, mouseMove: true, mouseDown: true, mouseUp: true, mouseWheel: true, highlight: true, download: true,
  console: true, network: true, captureStart: true, captureStop: true, interceptEnable: true, interceptDisable: true, interceptList: true,
  cookieGet: true, cookieSet: true, cookieDelete: true, storageLocalGet: true, storageLocalSet: true, storageLocalClear: true,
  storageSessionGet: true, storageSessionSet: true, storageSessionClear: true, viewport: true, geolocation: true, setDevice: true,
  setOffline: true, setHeaders: true, setCredentials: true, setMedia: true, clipboardRead: true, clipboardWrite: true, dialogAccept: true,
  dialogDismiss: true, profileShow: true, profileSet: true, profileUseDefault: true, openUrl: true, exec: true
}

const FLAG_ALIASES: Readonly<Record<string, string>> = {
  label: 'name',
  scale: 'deviceScaleFactor',
  'source-profile': 'sourceProfile'
}

function camelCase(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
}

function splitCommaList(value: unknown, flag: string, context: CliContext): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null
  if (!values || values.length === 0 || !values.every((item) => typeof item === 'string' && item.length > 0)) {
    throw context.usage(`--${flag} must contain a comma-separated non-empty list`)
  }
  return values as string[]
}
type CliPartitionKey = { topLevelSite: string; hasCrossSiteAncestor: boolean }
const PARTITION_KEY_FLAG_SCHEMA: Schema = {
  type: 'object',
  properties: { topLevelSite: { type: 'string' }, hasCrossSiteAncestor: { type: 'boolean' } },
  required: ['topLevelSite', 'hasCrossSiteAncestor'],
  additionalProperties: false
}

function parsePartitionKeyFlag(value: unknown, flag: string, context: CliContext): CliPartitionKey {
  // The core CLI already parses flags declared with type:json.
  const failure = validateValue(PARTITION_KEY_FLAG_SCHEMA, value, `--${flag}`)
  if (failure) throw context.usage(failure)
  // The named flag schema above establishes this boundary type.
  const partitionKey = value as CliPartitionKey
  if (partitionKey.topLevelSite.length === 0) throw context.usage(`--${flag} requires a nonempty topLevelSite`)
  return partitionKey
}

async function expandLargeValue(context: CliContext, value: unknown): Promise<unknown> {
  if (typeof value !== 'string' || !value.startsWith('@file:')) return value
  const source = value.slice('@file:'.length)
  const path = source === '-' ? '/dev/stdin' : resolve(context.cwd, source)
  return await context.readFile(path)
}

function format(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

async function runGeneric(id: string, args: CliArgs, context: CliContext): Promise<void> {
  const method = COMMAND_METHODS[id]
  if (!method) throw context.usage(`unknown browser command ${id}`)
  const params: Record<string, unknown> = {}
  for (const [flag, value] of Object.entries(args.flags)) {
    if (id === 'tabList' && flag === 'show-profile') continue
    const key = FLAG_ALIASES[flag] ?? camelCase(flag)
    if (key === 'files' || key === 'patterns') params[key] = splitCommaList(value, flag, context)
    else if (key === 'partitionKey') params[key] = parsePartitionKeyFlag(value, flag, context)
    else if (['expression', 'input', 'text', 'value', 'command'].includes(key)) params[key] = await expandLargeValue(context, value)
    else params[key] = value
  }
  if (id === 'find') {
    const locator = params.locator
    const index = params.index
    if (locator === 'nth') {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < -2_147_483_648 || index > 2_147_483_647) {
        throw context.usage('--index is required for find locator nth and must be a signed 32-bit integer')
      }
    } else if (index !== undefined) {
      throw context.usage('--index is only valid with find locator nth')
    }
  }
  if (Object.hasOwn(PAGE_TARGET_COMMANDS, id)) params.cwd = context.cwd
  if (id === 'tabList' && args.flags['show-profile'] === true) {
    const result = await context.call(`quirky.browser/${method}`, params) as { tabs: Array<Record<string, unknown>> }
    const profiles = await context.call('quirky.browser/profileList', {}) as { profiles: Array<{ id: string; label: string }> }
    const labels = new Map(profiles.profiles.map((profile) => [profile.id, profile.label]))
    const tabs: Array<Record<string, unknown> & { profileLabel: string | null }> = result.tabs.map((tab) => ({ ...tab, profileLabel: labels.get(String(tab.profileId)) ?? null }))
    context.out.result({ tabs }, () => context.format.table(['page', 'profile', 'url', 'title'], tabs.map((tab) => [String(tab.browserPageId), String(tab.profileLabel ?? ''), String(tab.url), String(tab.title)])))
    return
  }
  if (id === 'upload') params.files = (params.files as string[]).map((path) => resolve(context.cwd, path))
  if (id === 'download' && typeof params.path === 'string') params.path = resolve(context.cwd, params.path)
  const result = await context.call(`quirky.browser/${method}`, params)
  context.out.result(result, () => format(result))
}

async function runImportFile(args: CliArgs, context: CliContext): Promise<void> {
  const path = args.flags.path
  if (typeof path !== 'string' || path === '') throw context.usage('missing --path')
  if (args.flags.family !== undefined || args.flags['source-profile'] !== undefined) throw context.usage('file import does not accept --family or --source-profile')
  const profile = args.flags.profile
  const source = { kind: 'file', path: resolve(context.cwd, path) }
  const result = await context.call('quirky.browser/importCookies', { ...(typeof profile === 'string' ? { profile } : {}), source })
  context.out.result(result, () => format(result))
}

async function runImportBrowser(args: CliArgs, context: CliContext): Promise<void> {
  const family = args.flags.family
  if (typeof family !== 'string' || family === '') throw context.usage('missing --family')
  if (args.flags.path !== undefined || args.flags.file !== undefined) throw context.usage('browser import does not accept --path or --file')
  const sourceProfile = args.flags['source-profile']
  const profile = args.flags.profile
  const source = { kind: 'browser', family, ...(typeof sourceProfile === 'string' ? { profile: sourceProfile } : {}) }
  const result = await context.call('quirky.browser/importCookies', { ...(typeof profile === 'string' ? { profile } : {}), source })
  context.out.result(result, () => format(result))
}

async function runImportStart(args: CliArgs, context: CliContext): Promise<void> {
  const file = args.flags.file
  const browser = args.flags.browser
  const sourceProfile = args.flags['source-profile']
  if ((typeof file === 'string') === (typeof browser === 'string')) throw context.usage('pass exactly one of --file or --browser')
  if (sourceProfile !== undefined && typeof browser !== 'string') throw context.usage('--source-profile requires --browser')
  const source = typeof file === 'string'
    ? { kind: 'file', path: resolve(context.cwd, file) }
    : { kind: 'browser', family: browser as string, ...(typeof sourceProfile === 'string' ? { profile: sourceProfile } : {}) }
  const profile = args.flags.profile
  const result = await context.call('quirky.browser/importStart', { ...(typeof profile === 'string' ? { profile } : {}), source })
  context.out.result(result, () => format(result))
}

async function runProfileClone(args: CliArgs, context: CliContext): Promise<void> {
  const profile = args.flags.profile
  if (typeof profile !== 'string' || profile === '') throw context.usage('missing --profile')
  const sourcePage = args.flags.page
  let source: string
  if (typeof sourcePage === 'string') source = sourcePage
  else {
    const target: Record<string, unknown> = { cwd: context.cwd }
    if (typeof args.flags.worktree === 'string') target.worktree = args.flags.worktree
    const current = await context.call('quirky.browser/tabCurrent', target) as { tab: { browserPageId: string } }
    source = current.tab.browserPageId
  }
  const result = await context.call('quirky.browser/profileClone', { profile, source })
  context.out.result(result, () => format(result))
}

async function runImportGet(args: CliArgs, context: CliContext): Promise<void> {
  const id = args.flags.id
  if (typeof id !== 'string' || id === '') throw context.usage('missing --id')
  const result = await context.call('quirky.browser/importGet', { id })
  context.out.result(result, () => format(result))
}

async function runImportList(args: CliArgs, context: CliContext): Promise<void> {
  const params: Record<string, unknown> = {}
  if (typeof args.flags.profile === 'string') params.profile = args.flags.profile
  if (typeof args.flags.status === 'string') params.status = args.flags.status
  const result = await context.call('quirky.browser/importList', params)
  context.out.result(result, () => format(result))
}

async function runImportDetect(_args: CliArgs, context: CliContext): Promise<void> {
  const result = await context.call('quirky.browser/detectBrowsers', {})
  context.out.result(result, () => format(result))
}

const CUSTOM: Readonly<Record<string, (args: CliArgs, context: CliContext) => Promise<void>>> = {
  importFile: runImportFile,
  importBrowser: runImportBrowser,
  importStart: runImportStart,
  profileClone: runProfileClone,
  importGet: runImportGet,
  importList: runImportList,
  detectBrowsers: runImportDetect
}

const COMMAND_IDS = [
  'tabList','tabShow','tabCurrent','tabCreate','tabSwitch','tabClose','snapshot','screenshot','fullScreenshot','pdf','goto','back','forward','reload',
  'click','dblclick','fill','type','keyboardInsertText','keypress','select','check','uncheck','focus','hover','scrollIntoView','clear','selectAll','drag','upload',
  'scroll','wait','eval','get','is','find','mouseMove','mouseDown','mouseUp','mouseWheel','highlight','download','console','network','captureStart','captureStop',
  'interceptEnable','interceptDisable','interceptList','cookieGet','cookieSet','cookieDelete','storageLocalGet','storageLocalSet','storageLocalClear',
  'storageSessionGet','storageSessionSet','storageSessionClear','viewport','geolocation','setDevice','setOffline','setHeaders','setCredentials','setMedia',
  'clipboardRead','clipboardWrite','dialogAccept','dialogDismiss','profileList','profileCreate','profileDelete','profileShow','profileSet','profileUseDefault',
  'identityGet','identitySet','openUrl','exec'
]

const commands: CliModule['commands'] = Object.create(null) as CliModule['commands']
for (const id of COMMAND_IDS) {
  commands[id] = async (args, context) => await runGeneric(id, args, context)
}
for (const [id, handler] of Object.entries(CUSTOM)) commands[id] = handler

export { commands }
