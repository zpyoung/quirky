import { resolve } from 'node:path'
import { validateValue, type CliArgs, type CliContext, type CliModule, type Schema } from '@quirky/protocol'
import type { BrowserMethod } from './src/runtime/catalog'
import type { BrowserPage } from './src/profiles/store'

type CliBrowserMethod = BrowserMethod | 'preferencesState' | 'profileSet' | 'profileClear' | 'profileDelete' | 'openLink' | 'localhostLabelRegister' | 'localhostLabelList'
type InputField = { inline: string; option: 'value' | 'expression' | 'text'; target: string; required?: boolean }

const COMMAND_METHODS: Readonly<Record<string, CliBrowserMethod>> = {
  preferencesState: 'preferencesState', profileSet: 'profileSet', profileClear: 'profileClear', profileDelete: 'profileDelete', openLink: 'openLink',
  localhostLabelRegister: 'localhostLabelRegister', localhostLabelList: 'localhostLabelList',
  profileList: 'profileList', profileCreate: 'profileCreate', profileClone: 'profileClone',
  tabList: 'tabList', tabShow: 'tabShow', tabCurrent: 'tabCurrent', tabCreate: 'tabCreate', tabSwitch: 'tabSwitch', tabClose: 'tabClose',
  tabProfileShow: 'tabProfileShow', tabProfileSet: 'tabProfileSet', tabProfileUseDefault: 'tabProfileUseDefault',
  snapshot: 'snapshot', screenshot: 'screenshot', fullScreenshot: 'fullScreenshot', pdf: 'pdf',
  goto: 'goto', back: 'back', forward: 'forward', reload: 'reload',
  click: 'click', dblclick: 'dblclick', fill: 'fill', type: 'type', keyboardInsertText: 'keyboardInsertText', keypress: 'keypress',
  select: 'select', check: 'check', uncheck: 'uncheck', focus: 'focus', hover: 'hover', scrollIntoView: 'scrollIntoView',
  clear: 'clear', selectAll: 'selectAll', drag: 'drag', upload: 'upload', scroll: 'scroll', wait: 'wait',
  eval: 'eval', get: 'get', is: 'is', find: 'find', mouseMove: 'mouseMove', mouseDown: 'mouseDown', mouseUp: 'mouseUp',
  mouseWheel: 'mouseWheel', highlight: 'highlight', download: 'download', console: 'console', network: 'network',
  captureStart: 'captureStart', captureStop: 'captureStop', interceptEnable: 'interceptEnable', interceptDisable: 'interceptDisable',
  interceptList: 'interceptList', cookieGet: 'cookieGet', cookieSet: 'cookieSet', cookieDelete: 'cookieDelete',
  storageLocalGet: 'storageLocalGet', storageLocalSet: 'storageLocalSet', storageLocalClear: 'storageLocalClear',
  storageSessionGet: 'storageSessionGet', storageSessionSet: 'storageSessionSet', storageSessionClear: 'storageSessionClear',
  viewport: 'viewport', geolocation: 'geolocation', setDevice: 'setDevice', setOffline: 'setOffline', setHeaders: 'setHeaders',
  setCredentials: 'setCredentials', setMedia: 'setMedia', clipboardRead: 'clipboardRead', clipboardWrite: 'clipboardWrite',
  dialogAccept: 'dialogAccept', dialogDismiss: 'dialogDismiss', detectBrowsers: 'detectBrowsers',
  importFile: 'importCookies', importBrowser: 'importCookies', importStart: 'importStart', importGet: 'importGet', importList: 'importList',
  identityGet: 'identityGet', identitySet: 'identitySet', openUrl: 'openUrl', exec: 'exec',
  paneOpen: 'paneOpen', paneState: 'paneState', paneNavigate: 'paneNavigate', paneControl: 'paneControl',
  paneReport: 'paneReport', paneClose: 'paneClose', paneSuggestions: 'paneSuggestions', paneWatch: 'paneWatch',
  paneWatchStop: 'paneWatchStop', paneFrameAck: 'paneFrameAck', paneInput: 'paneInput', paneRespond: 'paneRespond', paneDownload: 'paneDownload',
  designArm: 'designArm', designRead: 'designRead', designHover: 'designHover', designCancel: 'designCancel',
  designCapture: 'designCapture', designFormat: 'designFormat', designTargets: 'designTargets', designSend: 'designSend'
}

const PAGE_TARGET_COMMANDS: Readonly<Record<string, true>> = {
  tabList: true, tabShow: true, tabCurrent: true, tabCreate: true, tabSwitch: true, tabClose: true,
  tabProfileShow: true, tabProfileSet: true, tabProfileUseDefault: true,
  snapshot: true, screenshot: true, fullScreenshot: true, pdf: true, goto: true, back: true, forward: true, reload: true,
  click: true, dblclick: true, fill: true, type: true, keyboardInsertText: true, keypress: true, select: true, check: true, uncheck: true,
  focus: true, hover: true, scrollIntoView: true, clear: true, selectAll: true, drag: true, upload: true, scroll: true, wait: true,
  eval: true, get: true, is: true, find: true, mouseMove: true, mouseDown: true, mouseUp: true, mouseWheel: true, highlight: true,
  download: true, console: true, network: true, captureStart: true, captureStop: true, interceptEnable: true, interceptDisable: true,
  interceptList: true, cookieGet: true, cookieSet: true, cookieDelete: true, storageLocalGet: true, storageLocalSet: true,
  storageLocalClear: true, storageSessionGet: true, storageSessionSet: true, storageSessionClear: true, viewport: true,
  geolocation: true, setDevice: true, setOffline: true, setHeaders: true, setCredentials: true, setMedia: true,
  clipboardRead: true, clipboardWrite: true, dialogAccept: true, dialogDismiss: true, openUrl: true, exec: true
}

const INPUT_FIELDS: Readonly<Record<string, readonly InputField[]>> = {
  fill: [{ inline: 'value', option: 'value', target: 'value', required: true }],
  select: [{ inline: 'value', option: 'value', target: 'value', required: true }],
  cookieSet: [{ inline: 'value', option: 'value', target: 'value', required: true }],
  storageLocalSet: [{ inline: 'value', option: 'value', target: 'value', required: true }],
  storageSessionSet: [{ inline: 'value', option: 'value', target: 'value', required: true }],
  eval: [{ inline: 'expression', option: 'expression', target: 'expression', required: true }],
  find: [{ inline: 'value', option: 'value', target: 'value', required: true }, { inline: 'text', option: 'text', target: 'text' }],
  keyboardInsertText: [{ inline: 'text', option: 'text', target: 'text', required: true }],
  clipboardWrite: [{ inline: 'text', option: 'text', target: 'text', required: true }],
  dialogAccept: [{ inline: 'text', option: 'text', target: 'text' }],
  paneControl: [{ inline: 'text', option: 'text', target: 'text' }],
  paneInput: [{ inline: 'text', option: 'text', target: 'text' }],
  paneRespond: [{ inline: 'text', option: 'text', target: 'text' }],
  type: [{ inline: 'input', option: 'text', target: 'input', required: true }]
}

const FLAG_ALIASES: Readonly<Record<string, string>> = {
  label: 'name',
  scale: 'deviceScaleFactor'
}

const PARTITION_KEY_FLAG_SCHEMA: Schema = {
  type: 'object',
  properties: { topLevelSite: { type: 'string' }, hasCrossSiteAncestor: { type: 'boolean' } },
  required: ['topLevelSite', 'hasCrossSiteAncestor'],
  additionalProperties: false
}

function camelCase(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
}

function format(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function splitCommaList(value: unknown, flag: string, context: CliContext): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null
  if (!values || values.length === 0 || !values.every((item) => typeof item === 'string' && item.length > 0)) {
    throw context.usage(`--${flag} must contain a comma-separated non-empty list`)
  }
  return values as string[]
}

function parsePartitionKeyFlag(value: unknown, flag: string, context: CliContext): Record<string, unknown> {
  const failure = validateValue(PARTITION_KEY_FLAG_SCHEMA, value, `--${flag}`)
  if (failure) throw context.usage(failure)
  const partitionKey = value as Record<string, unknown>
  if (typeof partitionKey.topLevelSite !== 'string' || partitionKey.topLevelSite.length === 0) {
    throw context.usage(`--${flag} requires a nonempty topLevelSite`)
  }
  return partitionKey
}

function inputFlags(field: InputField): string[] {
  return [field.inline, `${field.option}-file`, `${field.option}-stdin`]
}

function assertInputModes(id: string, args: CliArgs, context: CliContext): void {
  for (const field of INPUT_FIELDS[id] ?? []) {
    const modes = Number(Object.hasOwn(args.flags, field.inline)) +
      Number(Object.hasOwn(args.flags, `${field.option}-file`)) +
      Number(args.flags[`${field.option}-stdin`] === true)
    if (modes > 1) throw context.usage(`use only one of --${field.inline}, --${field.option}-file, or --${field.option}-stdin`)
    if (modes === 0 && field.required) {
      throw context.usage(`missing --${field.inline}; use --${field.option}-file or --${field.option}-stdin for explicit input`)
    }
  }
}

async function readInput(field: InputField, args: CliArgs, context: CliContext): Promise<string | undefined> {
  const fileFlag = `${field.option}-file`
  const stdinFlag = `${field.option}-stdin`
  if (Object.hasOwn(args.flags, fileFlag)) {
    const path = args.flags[fileFlag]
    if (typeof path !== 'string' || path.length === 0) throw context.usage(`--${fileFlag} requires a file path`)
    return await context.readFile(resolve(context.cwd, path))
  }
  if (args.flags[stdinFlag] === true) return await Bun.stdin.text()
  const inline = args.flags[field.inline]
  return typeof inline === 'string' ? inline : undefined
}

function parseJsonFlag(id: string, key: string, value: unknown): boolean {
  return (id === 'designFormat' && (key === 'payload' || key === 'annotations')) ||
    (id === 'designSend' && key === 'annotations') || (id === 'designCapture' && key === 'rect')
}

async function runGeneric(id: string, args: CliArgs, context: CliContext): Promise<void> {
  const method = COMMAND_METHODS[id]
  if (!method) throw context.usage(`unknown browser command ${id}`)
  assertInputModes(id, args, context)
  const inputFields = INPUT_FIELDS[id] ?? []
  const inputFlagNames = new Set(inputFields.flatMap(inputFlags))
  const params: Record<string, unknown> = {}
  for (const [flag, value] of Object.entries(args.flags)) {
    if (inputFlagNames.has(flag) || (id === 'tabList' && flag === 'show-profile')) continue
    const key = FLAG_ALIASES[flag] ?? camelCase(flag)
    if (key === 'files' || key === 'patterns') params[key] = splitCommaList(value, flag, context)
    else if (key === 'partitionKey') params[key] = parsePartitionKeyFlag(value, flag, context)
    else if (parseJsonFlag(id, key, value) && typeof value === 'string') {
      try {
        params[key] = JSON.parse(value)
      } catch {
        throw context.usage(`--${flag} must contain valid JSON`)
      }
    } else {
      params[key] = value
    }
  }
  for (const field of inputFields) {
    const value = await readInput(field, args, context)
    if (value !== undefined) params[field.target] = value
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
  if (Object.hasOwn(params, 'files') && id === 'upload') {
    params.files = (params.files as string[]).map((path) => resolve(context.cwd, path))
  }
  if (id === 'download' && typeof params.path === 'string') params.path = resolve(context.cwd, params.path)
  if (id === 'tabList' && args.flags['show-profile'] === true) {
    const result = await context.call(`quirky.browser/${method}`, params) as { tabs: BrowserPage[] }
    const profiles = await context.call('quirky.browser/profileList', {}) as { profiles: Array<{ id: string; label: string }> }
    const labels = new Map(profiles.profiles.map((profile) => [profile.id, profile.label]))
    const tabs = result.tabs.map((tab) => ({ ...tab, profileLabel: labels.get(String(tab.profileId)) ?? null }))
    context.out.result({ tabs }, () => context.format.table(['page', 'profile', 'url', 'title'], tabs.map((tab) => [
      String(tab.browserPageId), String(tab.profileLabel ?? ''), String(tab.url), String(tab.title)
    ])))
    return
  }
  const result = await context.call(`quirky.browser/${method}`, params)
  context.out.result(result, () => format(result))
}

async function importFile(args: CliArgs, context: CliContext): Promise<void> {
  const file = args.flags.file
  if (typeof file !== 'string' || file === '') throw context.usage('missing --file')
  if (args.flags.family !== undefined || args.flags['source-profile'] !== undefined) throw context.usage('file import does not accept --family or --source-profile')
  const profile = args.flags.profile
  const source = { kind: 'file', path: resolve(context.cwd, file) }
  const result = await context.call('quirky.browser/importCookies', { ...(typeof profile === 'string' ? { profile } : {}), source })
  context.out.result(result, () => format(result))
}

async function importBrowser(args: CliArgs, context: CliContext): Promise<void> {
  const family = args.flags.family
  if (typeof family !== 'string' || family === '') throw context.usage('missing --family')
  if (args.flags.file !== undefined) throw context.usage('browser import does not accept --file')
  const sourceProfile = args.flags['source-profile']
  const profile = args.flags.profile
  const source = { kind: 'browser', family, ...(typeof sourceProfile === 'string' ? { profile: sourceProfile } : {}) }
  const result = await context.call('quirky.browser/importCookies', { ...(typeof profile === 'string' ? { profile } : {}), source })
  context.out.result(result, () => format(result))
}

async function importStart(args: CliArgs, context: CliContext): Promise<void> {
  const file = args.flags.file
  const browser = args.flags.browser
  const sourceProfile = args.flags['source-profile']
  const hasFile = typeof file === 'string'
  const hasBrowser = typeof browser === 'string'
  if (hasFile && file === '') throw context.usage('--file requires a path')
  if (hasBrowser && browser === '') throw context.usage('--browser requires a family')
  if (hasFile === hasBrowser) throw context.usage('pass exactly one of --file or --browser')
  if (sourceProfile !== undefined && !hasBrowser) throw context.usage('--source-profile requires --browser')
  if (sourceProfile !== undefined && (typeof sourceProfile !== 'string' || sourceProfile === '')) {
    throw context.usage('--source-profile requires a non-empty browser profile')
  }
  const source = hasFile
    ? { kind: 'file', path: resolve(context.cwd, file as string) }
    : { kind: 'browser', family: browser as string, ...(typeof sourceProfile === 'string' ? { profile: sourceProfile } : {}) }
  const profile = args.flags.profile
  const result = await context.call('quirky.browser/importStart', { ...(typeof profile === 'string' ? { profile } : {}), source })
  context.out.result(result, () => format(result))
}

async function profileClone(args: CliArgs, context: CliContext): Promise<void> {
  const profile = args.flags.profile
  if (typeof profile !== 'string' || profile === '') throw context.usage('missing --profile')
  const page = args.flags.page
  let source: string
  if (typeof page === 'string') source = page
  else {
    const target: Record<string, unknown> = { cwd: context.cwd }
    if (typeof args.flags.worktree === 'string') target.worktree = args.flags.worktree
    const current = await context.call('quirky.browser/tabCurrent', target) as { tab: { browserPageId: string } }
    source = current.tab.browserPageId
  }
  const result = await context.call('quirky.browser/profileClone', { profile, source })
  context.out.result(result, () => format(result))
}

async function importGet(args: CliArgs, context: CliContext): Promise<void> {
  const id = args.flags.id
  if (typeof id !== 'string' || id === '') throw context.usage('missing --id')
  const result = await context.call('quirky.browser/importGet', { id })
  context.out.result(result, () => format(result))
}

async function importList(args: CliArgs, context: CliContext): Promise<void> {
  const params: Record<string, unknown> = {}
  if (typeof args.flags.profile === 'string') params.profile = args.flags.profile
  if (typeof args.flags.status === 'string') params.status = args.flags.status
  const result = await context.call('quirky.browser/importList', params)
  context.out.result(result, () => format(result))
}

async function detectBrowsers(_args: CliArgs, context: CliContext): Promise<void> {
  const result = await context.call('quirky.browser/detectBrowsers', {})
  context.out.result(result, () => format(result))
}

const CUSTOM: Readonly<Record<string, (args: CliArgs, context: CliContext) => Promise<void>>> = {
  importFile,
  importBrowser,
  importStart,
  profileClone,
  importGet,
  importList,
  detectBrowsers
}

const commands: CliModule['commands'] = Object.create(null) as CliModule['commands']
for (const id of Object.keys(COMMAND_METHODS)) {
  commands[id] = async (args, context) => await runGeneric(id, args, context)
}
for (const [id, handler] of Object.entries(CUSTOM)) commands[id] = handler

export { commands }
