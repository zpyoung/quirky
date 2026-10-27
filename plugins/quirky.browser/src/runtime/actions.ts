import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { validateValue, type Schema } from '@quirky/protocol'
import { BrowserFault, fault } from './errors'
import { BrowserRuntime, browserDevice, type JsonValue, type PageExecution } from './driver'
import type { BrowserStore } from '../profiles/store'
import type { BrowserMethod } from './catalog'
import type { Cookie, SameSite } from '../cookies/types'

type SnapshotRef = { ref: string; role: string; name: string }
type RefEntry = { pageId: string; projectionId: string; generation: number; helperRef: string }
type Projection = { id: string; generation: number; refs: SnapshotRef[] }

const HELPER_OBJECT_SCHEMA: Schema = { type: 'object', additionalProperties: true }
const SNAPSHOT_SCHEMA: Schema = {
  type: 'object',
  properties: { snapshot: { type: 'string' }, refs: { type: 'object', additionalProperties: true }, url: { type: 'string' }, title: { type: 'string' } },
  required: ['snapshot', 'refs'],
  additionalProperties: true
}
const SNAPSHOT_REF_SCHEMA: Schema = {
  type: 'object',
  properties: { name: { type: 'string' }, role: { type: 'string' } },
  additionalProperties: true
}
const CAPTURE_SCHEMA: Schema = {
  type: 'object',
  properties: { data: { type: 'string' } },
  required: ['data'],
  additionalProperties: true
}
const RECT_SCHEMA: Schema = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
  required: ['x', 'y', 'width', 'height'],
  additionalProperties: true
}

const ELEMENT_ACTIONS: Readonly<Record<string, true>> = {
  click: true,
  dblclick: true,
  fill: true,
  select: true,
  check: true,
  uncheck: true,
  focus: true,
  hover: true,
  scrollIntoView: true,
  clear: true,
  selectAll: true,
  upload: true,
  get: true,
  is: true,
  wait: true,
  highlight: true,
  download: true
}

function stringParam(params: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = params[key]
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw fault('invalid_argument', `${key} must be a ${allowEmpty ? 'string' : 'non-empty string'}`)
  return value
}

function numberParam(params: Record<string, unknown>, key: string, defaultValue?: number): number {
  const value = params[key]
  if (value === undefined && defaultValue !== undefined) return defaultValue
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fault('invalid_argument', `${key} must be a finite number`)
  return value
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw fault('invalid_argument', `${key} must be a string`)
  return value
}

function samePartition(a: Cookie['partitionKey'], b: Cookie['partitionKey']): boolean {
  return a?.topLevelSite === b?.topLevelSite && a?.hasCrossSiteAncestor === b?.hasCrossSiteAncestor
}
function partitionKeyParam(value: unknown): Cookie['partitionKey'] | undefined {
  if (value === undefined) return undefined
  const schema: Schema = {
    type: 'object',
    properties: { topLevelSite: { type: 'string' }, hasCrossSiteAncestor: { type: 'boolean' } },
    required: ['topLevelSite', 'hasCrossSiteAncestor'],
    additionalProperties: false
  }
  if (validateValue(schema, value, 'partition key')) throw fault('invalid_argument', 'partition key must be an exact object')
  const partition = value as { topLevelSite: string; hasCrossSiteAncestor: boolean }
  if (partition.topLevelSite.length === 0) throw fault('invalid_argument', 'partition key topLevelSite must not be empty')
  return { topLevelSite: partition.topLevelSite, hasCrossSiteAncestor: partition.hasCrossSiteAncestor }
}
const FIND_LOCATORS = ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last', 'nth'] as const
const FIND_ACTIONS = ['click', 'fill', 'type', 'hover', 'focus', 'check', 'uncheck', 'text'] as const
type FindParams = { locator: string; value: string; action: string; index?: number; text?: string }

function parseFindParams(params: Record<string, unknown>): FindParams {
  const locator = stringParam(params, 'locator')
  const value = stringParam(params, 'value')
  const action = stringParam(params, 'action')
  if (!FIND_LOCATORS.some((name) => name === locator)) throw fault('invalid_argument', 'unsupported semantic locator')
  if (!FIND_ACTIONS.some((name) => name === action)) throw fault('invalid_argument', 'unsupported semantic action')
  let index: number | undefined
  if (locator === 'nth') {
    const candidateIndex = params.index
    if (typeof candidateIndex !== 'number' || !Number.isInteger(candidateIndex) || candidateIndex < -2_147_483_648 || candidateIndex > 2_147_483_647) {
      throw fault('invalid_argument', 'nth locator requires a signed 32-bit integer index')
    }
    index = candidateIndex
  } else if (params.index !== undefined) {
    throw fault('invalid_argument', 'find index is only valid with locator nth')
  }
  const text = params.text === undefined ? undefined : stringParam(params, 'text', true)
  return { locator, value, action, ...(index === undefined ? {} : { index }), ...(text === undefined ? {} : { text }) }
}

export function validateFindParams(params: Record<string, unknown>): void {
  parseFindParams(params)
}

const FIND_DOM_ACTION_SCRIPT = `((input) => {
  const normalized = value => String(value ?? '').replace(/\\s+/g, ' ').trim().toLocaleLowerCase()
  const includes = (actual, expected) => normalized(actual).includes(normalized(expected))
  const textOf = element => element.innerText ?? element.textContent ?? ''
  const accessibleName = element => {
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ')
      if (text.trim()) return text
    }
    const ariaLabel = element.getAttribute('aria-label')
    if (ariaLabel) return ariaLabel
    if (element.labels?.length) return Array.from(element.labels).map(textOf).join(' ')
    return element.getAttribute('alt') ?? element.getAttribute('title') ?? element.value ?? textOf(element)
  }
  const roleOf = element => {
    const explicit = element.getAttribute('role')?.trim().split(/\\s+/)[0]
    if (explicit) return explicit
    const tag = element.localName
    if (tag === 'button') return 'button'
    if (tag === 'a' && element.hasAttribute('href')) return 'link'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return 'img'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (tag === 'li') return 'listitem'
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'search') return 'searchbox'
      if (type === 'hidden') return ''
      return 'textbox'
    }
    return ''
  }
  let element
  if (input.locator === 'first' || input.locator === 'last' || input.locator === 'nth') {
    const matches = Array.from(document.querySelectorAll(input.value))
    let index = input.locator === 'first' ? 0 : input.locator === 'last' ? matches.length - 1 : input.index
    if (index < 0) index += matches.length
    element = matches[index]
  } else if (input.locator === 'label') {
    const label = Array.from(document.querySelectorAll('label')).find(candidate => includes(textOf(candidate), input.value))
    element = label?.control ?? label?.querySelector('input,textarea,select,button')
  } else {
    const all = Array.from(document.querySelectorAll('body *'))
    if (input.locator === 'role') element = all.find(candidate => roleOf(candidate) === input.value)
    else if (input.locator === 'text') {
      const candidates = all.filter(candidate => includes(textOf(candidate), input.value))
      element = candidates.find(candidate => !Array.from(candidate.children).some(child => includes(textOf(child), input.value))) ?? candidates[0]
    } else if (input.locator === 'placeholder') element = Array.from(document.querySelectorAll('[placeholder]')).find(candidate => includes(candidate.getAttribute('placeholder'), input.value))
    else if (input.locator === 'alt') element = Array.from(document.querySelectorAll('[alt]')).find(candidate => includes(candidate.getAttribute('alt'), input.value))
    else if (input.locator === 'title') element = Array.from(document.querySelectorAll('[title]')).find(candidate => includes(candidate.getAttribute('title'), input.value))
    else if (input.locator === 'testid') element = Array.from(document.querySelectorAll('[data-testid]')).find(candidate => candidate.getAttribute('data-testid') === input.value)
  }
  if (!element) throw new Error('semantic locator did not match an element')
  if (input.action === 'focus' || input.action === 'type') {
    if (typeof element.focus !== 'function') throw new Error('semantic locator did not match a focusable element')
    element.focus()
    return true
  }
  if (input.action === 'uncheck') {
    if (typeof element.checked !== 'boolean') throw new Error('semantic locator did not match a checkable element')
    if (element.checked) element.click()
    return true
  }
  throw new Error('unsupported scoped semantic action')
})`
export class BrowserActions {
  private readonly refs = new Map<string, RefEntry>()
  private readonly projections = new Map<string, Projection>()

  constructor(private readonly store: BrowserStore, private readonly runtime: BrowserRuntime) {}

  clearPageRefs(pageId: string): void {
    const projection = this.projections.get(pageId)
    if (!projection) return
    for (const ref of projection.refs) this.refs.delete(ref.ref)
    this.projections.delete(pageId)
  }

  async run(method: BrowserMethod, params: Record<string, unknown>, execution: PageExecution): Promise<unknown> {
    switch (method) {
      case 'snapshot': return await this.snapshot(execution)
      case 'screenshot': return await this.screenshot(execution, params, false)
      case 'fullScreenshot': return await this.screenshot(execution, params, true)
      case 'pdf': return await this.pdf(execution)
      case 'goto': return await this.goto(execution, stringParam(params, 'url'))
      case 'back': return await this.historyAction(execution, 'back')
      case 'forward': return await this.historyAction(execution, 'forward')
      case 'reload': return await this.historyAction(execution, 'reload')
      case 'click': return await this.elementAction(execution, method, params)
      case 'dblclick': return await this.elementAction(execution, method, params)
      case 'fill': return await this.elementAction(execution, method, params)
      case 'type': return await this.type(execution, params)
      case 'keyboardInsertText': return await this.insertText(execution, params)
      case 'keypress': return await this.keypress(execution, params)
      case 'select': return await this.elementAction(execution, method, params)
      case 'check': return await this.elementAction(execution, method, params)
      case 'uncheck': return await this.elementAction(execution, method, params)
      case 'focus': return await this.elementAction(execution, method, params)
      case 'hover': return await this.elementAction(execution, method, params)
      case 'scrollIntoView': return await this.elementAction(execution, method, params)
      case 'clear': return await this.elementAction(execution, method, params)
      case 'selectAll': return await this.elementAction(execution, method, params)
      case 'drag': return await this.drag(execution, params)
      case 'upload': return await this.upload(execution, params)
      case 'scroll': return await this.scroll(execution, params)
      case 'wait': return await this.wait(execution, params)
      case 'eval': return await this.evaluate(execution, params)
      case 'get': return await this.get(execution, params)
      case 'is': return await this.is(execution, params)
      case 'find': return await this.find(execution, params)
      case 'mouseMove': return await this.mouse(execution, method, params)
      case 'mouseDown': return await this.mouse(execution, method, params)
      case 'mouseUp': return await this.mouse(execution, method, params)
      case 'mouseWheel': return await this.mouse(execution, method, params)
      case 'highlight': return await this.elementAction(execution, method, params)
      case 'download': return await this.download(execution, params)
      case 'console': return this.console(execution, params)
      case 'network': return this.network(execution, params)
      case 'captureStart': return this.captureStart(execution)
      case 'captureStop': return this.captureStop(execution)
      case 'interceptEnable': return await this.interceptEnable(execution, params)
      case 'interceptDisable': return await this.interceptDisable(execution)
      case 'interceptList': return this.interceptList(execution)
      case 'cookieGet': return await this.cookieGet(execution, params)
      case 'cookieSet': return await this.cookieSet(execution, params)
      case 'cookieDelete': return await this.cookieDelete(execution, params)
      case 'storageLocalGet': return await this.storage(execution, params, 'local', 'get')
      case 'storageLocalSet': return await this.storage(execution, params, 'local', 'set')
      case 'storageLocalClear': return await this.storage(execution, params, 'local', 'clear')
      case 'storageSessionGet': return await this.storage(execution, params, 'session', 'get')
      case 'storageSessionSet': return await this.storage(execution, params, 'session', 'set')
      case 'storageSessionClear': return await this.storage(execution, params, 'session', 'clear')
      case 'viewport': return await this.viewport(execution, params)
      case 'geolocation': return await this.geolocation(execution, params)
      case 'setDevice': return await this.setDevice(execution, params)
      case 'setOffline': return await this.setOffline(execution, params)
      case 'setHeaders': return await this.setHeaders(execution, params)
      case 'setCredentials': return await this.setCredentials(execution, params)
      case 'setMedia': return await this.setMedia(execution, params)
      case 'clipboardRead': return await this.clipboard(execution, undefined)
      case 'clipboardWrite': return await this.clipboard(execution, stringParam(params, 'text'))
      case 'dialogAccept': return await this.runtime.answerDialog(execution.page.browserPageId, true, optionalString(params, 'text'))
      case 'dialogDismiss': return await this.runtime.answerDialog(execution.page.browserPageId, false)
      default: throw fault('browser_error', `no page action implementation exists for ${method}`)
    }
  }

  private async snapshot(execution: PageExecution) {
    this.clearPageRefs(execution.page.browserPageId)
    const response = await this.callHelper(execution, 'snapshot')
    const data = this.dataObject(response.data, SNAPSHOT_SCHEMA, 'snapshot')
    const rawRefs = data.refs as Record<string, unknown>
    const projectionId = randomUUID()
    const refs: SnapshotRef[] = []
    for (const [index, [helperRef, raw]] of Object.entries(rawRefs).entries()) {
      if (!/^e[1-9]\d*$/.test(helperRef)) throw fault('browser_tab_changed', 'snapshot helper returned an invalid private reference')
      const value = this.dataObject(raw, SNAPSHOT_REF_SCHEMA, 'snapshot reference')
      const token = `qbr1:${projectionId}:${index + 1}`
      const ref: SnapshotRef = { ref: token, role: typeof value.role === 'string' ? value.role : '', name: typeof value.name === 'string' ? value.name : '' }
      refs.push(ref)
      this.refs.set(token, { pageId: execution.page.browserPageId, projectionId, generation: execution.binding.pageGeneration, helperRef: `@${helperRef}` })
    }
    const previous = this.projections.get(execution.page.browserPageId)
    if (previous) for (const ref of previous.refs) this.refs.delete(ref.ref)
    this.projections.set(execution.page.browserPageId, { id: projectionId, generation: execution.binding.pageGeneration, refs })
    const location = await this.runtime.pageLocation(execution)
    return {
      browserPageId: execution.page.browserPageId,
      projectionId,
      url: location.url,
      title: location.title,
      snapshot: data.snapshot as string,
      refs
    }
  }

  private async screenshot(execution: PageExecution, params: Record<string, unknown>, fullPage: boolean) {
    const format = params.format === 'jpeg' ? 'jpeg' : 'png'
    const options: Record<string, unknown> = { format, fromSurface: true, captureBeyondViewport: fullPage }
    if (fullPage) {
      const metrics = await execution.cdp.send('Page.getLayoutMetrics', {}, execution.binding.sessionId)
      const layout = this.dataObject(metrics, {
        type: 'object', properties: { cssContentSize: { type: 'object', additionalProperties: true } }, required: ['cssContentSize'], additionalProperties: true
      }, 'page layout metrics')
      const size = this.dataObject(layout.cssContentSize, {
        type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'], additionalProperties: true
      }, 'page content size')
      options.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
    }
    const captured = this.dataObject(await execution.cdp.send('Page.captureScreenshot', options, execution.binding.sessionId), CAPTURE_SCHEMA, 'screenshot')
    const data = this.captureFile(captured.data as string)
    return { data, format }
  }

  private async pdf(execution: PageExecution): Promise<{ data: string }> {
    const captured = this.dataObject(await execution.cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true }, execution.binding.sessionId), CAPTURE_SCHEMA, 'PDF capture')
    return { data: this.captureFile(captured.data as string) }
  }

  private captureFile(data: string): string {
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > 50 * 1024 * 1024) throw fault('browser_error', 'browser capture exceeded the 50 MiB output limit')
    const directory = join(this.store.dataDir, 'captures')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    const path = join(directory, randomUUID())
    try {
      writeFileSync(path, bytes, { mode: 0o600 })
      chmodSync(path, 0o600)
      return readFileSync(path).toString('base64')
    } finally {
      rmSync(path, { force: true })
    }
  }

  private async goto(execution: PageExecution, url: string) {
    const target = this.absoluteUrl(url, true)
    if (execution.settings.geolocation && target.origin !== 'null') {
      await execution.cdp.send('Browser.setPermission', { origin: target.origin, permission: { name: 'geolocation' }, setting: 'granted' })
    }
    let result
    try {
      result = await this.runtime.navigate(execution, url, 30_000)
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error)
      this.store.updatePage(execution.page.browserPageId, (record) => {
        record.url = url
        record.title = ''
        record.loadError = {
          code: error instanceof BrowserFault ? error.reason : 'navigation_failed',
          description: description.slice(0, 300),
          validatedUrl: url
        }
      })
      throw error
    }
    const page = this.store.updatePage(execution.page.browserPageId, (record) => {
      record.url = result.errorText ? url : result.url
      record.title = result.title
      record.loadError = result.errorText ? { code: 'navigation_failed', description: result.errorText.slice(0, 300), validatedUrl: url } : null
    })
    if (result.errorText) throw fault('browser_error', `navigation failed: ${result.errorText}`)
    return { url: page.url, title: page.title }
  }

  private async historyAction(execution: PageExecution, action: 'back' | 'forward' | 'reload') {
    const result = await this.runtime.historyNavigate(execution, action)
    if (!result.errorText) {
      const geolocation = this.runtime.pageSettings(execution.page.browserPageId).geolocation
      const origin = new URL(result.url).origin
      if (geolocation && origin !== 'null') {
        await execution.cdp.send('Browser.setPermission', { origin, permission: { name: 'geolocation' }, setting: 'granted' })
      }
    }
    const requestedUrl = result.requestedUrl ?? result.url
    const page = this.store.updatePage(execution.page.browserPageId, (record) => {
      record.url = result.errorText ? requestedUrl : result.url
      record.title = result.title
      record.loadError = result.errorText
        ? { code: 'navigation_failed', description: result.errorText.slice(0, 300), validatedUrl: requestedUrl }
        : null
    })
    if (result.errorText) throw fault('browser_error', `navigation failed: ${result.errorText}`)
    return { url: page.url, title: page.title }
  }

  private async elementAction(execution: PageExecution, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!Object.hasOwn(ELEMENT_ACTIONS, method)) throw fault('invalid_argument', 'the requested command does not accept an element selector')
    const field = method === 'highlight' || method === 'download' ? 'selector' : 'element'
    const supplied = stringParam(params, field)
    const helperRef = this.resolveElement(execution, supplied)
    const fields: Record<string, unknown> = { selector: helperRef }
    let action = method
    if (method === 'selectAll') {
      await this.callHelper(execution, 'focus', { selector: helperRef })
      await this.callHelper(execution, 'press', { key: process.platform === 'darwin' ? 'Meta+a' : 'Control+a' })
      return { selected: supplied }
    }
    if (method === 'fill') fields.value = stringParam(params, 'value', true)
    if (method === 'select') fields.value = stringParam(params, 'value')
    if (method === 'check') action = 'check'
    if (method === 'uncheck') action = 'uncheck'
    if (method === 'scrollIntoView') action = 'scrollintoview'
    if (method === 'highlight') fields.selector = helperRef
    if (method === 'upload') return await this.upload(execution, params)
    if (method === 'download') return await this.download(execution, params)
    await this.callHelper(execution, action, fields)
    if (method === 'click' || method === 'dblclick') return { clicked: supplied }
    if (method === 'fill') return { filled: supplied }
    if (method === 'select') return { selected: stringParam(params, 'value', true) }
    if (method === 'check') return { checked: true }
    if (method === 'uncheck') return { checked: false }
    if (method === 'focus') return { focused: supplied }
    if (method === 'hover') return { hovered: supplied }
    if (method === 'scrollIntoView') return { scrolledIntoView: supplied }
    if (method === 'clear') return { cleared: supplied }
    if (method === 'highlight') return { highlighted: supplied }
    throw fault('browser_error', 'element command result could not be constructed')
  }

  private async type(execution: PageExecution, params: Record<string, unknown>) {
    await this.typeScalars(execution, stringParam(params, 'input'), 'type')
    return { typed: true }
  }

  private async insertText(execution: PageExecution, params: Record<string, unknown>) {
    await this.typeScalars(execution, stringParam(params, 'text'), 'inserttext')
    return { inserted: true }
  }

  private async typeScalars(execution: PageExecution, text: string, mode: 'type' | 'inserttext'): Promise<void> {
    let offset = 0
    while (offset < text.length) {
      let end = offset
      let scalars = 0
      while (end < text.length && scalars < 512) {
        const codePoint = text.codePointAt(end)!
        end += codePoint > 0xffff ? 2 : 1
        scalars += 1
      }
      const chunk = text.slice(offset, end)
      if (mode === 'type') {
        await execution.cdp.send('Input.insertText', { text: chunk }, execution.binding.sessionId)
      } else {
        await this.callHelper(execution, 'inserttext', { text: chunk })
      }
      offset = end
    }
  }

  private async keypress(execution: PageExecution, params: Record<string, unknown>) {
    const key = stringParam(params, 'key')
    await this.callHelper(execution, 'press', { key })
    return { pressed: key }
  }

  private async drag(execution: PageExecution, params: Record<string, unknown>) {
    const from = stringParam(params, 'from')
    const to = stringParam(params, 'to')
    await this.callHelper(execution, 'drag', { from: this.resolveElement(execution, from), to: this.resolveElement(execution, to) })
    return { dragged: { from, to } }
  }

  private async upload(execution: PageExecution, params: Record<string, unknown>) {
    const element = stringParam(params, 'element')
    const files = params.files
    if (!Array.isArray(files) || files.length === 0 || !files.every((file) => typeof file === 'string' && file.length > 0 && isAbsolute(file))) {
      throw fault('invalid_argument', 'upload files must be a non-empty array of absolute paths')
    }
    for (const path of files as string[]) if (!existsSync(path)) throw fault('invalid_argument', 'an upload file does not exist')
    await this.callHelper(execution, 'upload', { selector: this.resolveElement(execution, element), files })
    return { uploaded: files.length }
  }

  private async scroll(execution: PageExecution, params: Record<string, unknown>) {
    const direction = stringParam(params, 'direction')
    if (direction !== 'up' && direction !== 'down') throw fault('invalid_argument', 'scroll direction must be up or down')
    const amount = numberParam(params, 'amount', 300)
    if (amount <= 0) throw fault('invalid_argument', 'scroll amount must be positive')
    await this.callHelper(execution, 'scroll', { direction, amount })
    return { scrolled: direction }
  }

  private async wait(execution: PageExecution, params: Record<string, unknown>) {
    const fields: Record<string, unknown> = {}
    const names: ReadonlyArray<readonly [string, string]> = [
      ['selector', 'selector'],
      ['timeout', 'timeout'],
      ['text', 'text'],
      ['url', 'url'],
      ['load', 'loadState'],
      ['fn', 'function'],
      ['state', 'state']
    ]
    for (const [parameter, field] of names) {
      if (params[parameter] !== undefined) fields[field] = params[parameter]
    }
    if (typeof fields.selector === 'string') fields.selector = this.resolveElement(execution, fields.selector)
    if (fields.state === undefined) fields.state = 'visible'
    const hasCondition = ['selector', 'text', 'url', 'loadState', 'function'].some((name) => fields[name] !== undefined) || fields.timeout !== undefined
    if (!hasCondition) throw fault('invalid_argument', 'wait requires a condition or timeout')
    const timeout = typeof fields.timeout === 'number' ? fields.timeout : 90_000
    if (timeout <= 0 || !Number.isFinite(timeout)) throw fault('invalid_argument', 'wait timeout must be positive and finite')
    const loadState = fields.loadState
    const hasEarlierCondition = fields.text !== undefined || fields.selector !== undefined || fields.url !== undefined || fields.function !== undefined
    if ((loadState === 'load' || loadState === 'domcontentloaded') && !hasEarlierCondition) {
      await this.runtime.waitForLoadState(execution, loadState, timeout)
      return { waited: true }
    }
    const helperTimeout = Math.min(timeout + 5_000, 95_000)
    const response = await this.callHelper(execution, 'wait', fields, helperTimeout)
    if (!response.success) this.helperFailure(response.error, 'wait')
    return { waited: true }
  }

  private async evaluate(execution: PageExecution, params: Record<string, unknown>) {
    const expression = stringParam(params, 'expression')
    const response = await execution.native('evaluate', { script: expression }, 90_000)
    if (!response.success) throw fault('browser_eval_error', 'page evaluation failed or returned a non-serializable value')
    const data = this.dataObject(response.data, HELPER_OBJECT_SCHEMA, 'evaluation response')
    const result = data.result
    if (result === undefined) throw fault('browser_eval_error', 'page evaluation did not return a serializable JSON value')
    return { value: result as JsonValue }
  }

  private async get(execution: PageExecution, params: Record<string, unknown>) {
    const what = stringParam(params, 'what')
    if (what === 'url' || what === 'title') {
      if (params.element !== undefined) throw fault('invalid_argument', 'get url and title do not accept an element')
      const location = await this.runtime.pageLocation(execution)
      return { value: what === 'url' ? location.url : location.title }
    }
    if (!['text', 'html', 'value', 'count', 'box'].includes(what)) throw fault('invalid_argument', 'get what must be url, title, text, html, value, count, or box')
    const element = stringParam(params, 'element')
    const selector = this.resolveElement(execution, element)
    const data = await this.callHelperData(execution, 'get', { what, selector })
    const value = this.dataValue(data, 'get')
    if (what === 'count') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw fault('browser_error', 'helper returned an invalid element count')
      return { value }
    }
    if (what === 'box') {
      const failure = validateValue(RECT_SCHEMA, value, 'element box')
      if (failure) throw fault('browser_error', 'helper returned an invalid element rectangle')
      return { value }
    }
    if (typeof value !== 'string') throw fault('browser_error', `helper returned a non-string ${what} value`)
    return { value }
  }

  private async is(execution: PageExecution, params: Record<string, unknown>) {
    const what = stringParam(params, 'what')
    if (!['visible', 'enabled', 'checked'].includes(what)) throw fault('invalid_argument', 'is what must be visible, enabled, or checked')
    const element = stringParam(params, 'element')
    const data = await this.callHelperData(execution, 'is', { what, selector: this.resolveElement(execution, element) })
    const value = this.dataValue(data, 'is')
    if (typeof value !== 'boolean') throw fault('browser_error', 'helper returned a non-boolean element state')
    return { value }
  }

  private async find(execution: PageExecution, params: Record<string, unknown>) {
    const { locator, value, action, index, text } = parseFindParams(params)
    if (action === 'type' || action === 'focus' || action === 'uncheck') {
      if (action === 'type' && text === undefined) throw fault('invalid_argument', 'find type action requires text')
      const response = await execution.cdp.send('Runtime.evaluate', {
        expression: `(${FIND_DOM_ACTION_SCRIPT})(${JSON.stringify({ locator, value, index, action })})`,
        returnByValue: true
      }, execution.binding.sessionId)
      const envelope = this.dataObject(response, {
        type: 'object', properties: { result: { type: 'object', properties: { value: {}, type: { type: 'string' } }, required: ['type'], additionalProperties: true }, exceptionDetails: {} },
        required: ['result'], additionalProperties: true
      }, 'semantic action result')
      if (envelope.exceptionDetails !== undefined) throw fault('browser_error', `semantic ${action} action failed`)
      const result = this.dataObject(envelope.result, {
        type: 'object', properties: { value: { type: 'boolean' }, type: { type: 'string' } }, required: ['type', 'value'], additionalProperties: true
      }, 'semantic action value')
      if (result.value !== true) throw fault('browser_error', `semantic ${action} action failed`)
      if (action === 'type' && text !== undefined) {
        await this.typeScalars(execution, text, 'type')
      }
      return { action, performed: true }
    }
    const fields: Record<string, unknown> = { subaction: action }
    let nativeAction: string
    switch (locator) {
      case 'role':
        nativeAction = 'getbyrole'
        fields.role = value
        fields.exact = false
        break
      case 'text':
        nativeAction = 'getbytext'
        fields.text = value
        fields.exact = false
        break
      case 'label':
        nativeAction = 'getbylabel'
        fields.label = value
        fields.exact = false
        break
      case 'placeholder':
        nativeAction = 'getbyplaceholder'
        fields.placeholder = value
        fields.exact = false
        break
      case 'alt':
        nativeAction = 'getbyalttext'
        fields.text = value
        fields.exact = false
        break
      case 'title':
        nativeAction = 'getbytitle'
        fields.text = value
        fields.exact = false
        break
      case 'testid':
        nativeAction = 'getbytestid'
        fields.testId = value
        break
      case 'first':
      case 'last':
      case 'nth':
        nativeAction = 'nth'
        fields.selector = value
        if (locator === 'first') fields.index = 0
        else if (locator === 'last') fields.index = -1
        else {
          if (index === undefined) throw fault('invalid_argument', 'nth locator requires a signed 32-bit integer index')
          fields.index = index
        }
        break
      default:
        throw fault('invalid_argument', 'unsupported semantic locator')
    }
    if (text !== undefined) fields.value = text
    const data = await this.callHelperData(execution, nativeAction, fields)
    if (action === 'text') {
      const text = data.text ?? data.value
      if (typeof text !== 'string') throw fault('browser_error', 'semantic text query returned no text value')
      return { action: 'text', text }
    }
    return { action, performed: true }
  }

  private async mouse(execution: PageExecution, method: string, params: Record<string, unknown>) {
    if (method === 'mouseMove') {
      const x = numberParam(params, 'x')
      const y = numberParam(params, 'y')
      await this.callHelper(execution, 'mouse_move', { x, y })
      return { moved: { x, y } }
    }
    if (method === 'mouseDown' || method === 'mouseUp') {
      const button = optionalString(params, 'button') ?? 'left'
      if (!['left', 'right', 'middle'].includes(button)) throw fault('invalid_argument', 'mouse button must be left, right, or middle')
      await this.callHelper(execution, method === 'mouseDown' ? 'mouse_down' : 'mouse_up', { button })
      return { button, down: method === 'mouseDown' }
    }
    const dy = numberParam(params, 'dy')
    const dx = numberParam(params, 'dx', 0)
    await this.callHelper(execution, 'mouse_wheel', { dx, dy })
    return { scrolled: { dx, dy } }
  }

  private async download(execution: PageExecution, params: Record<string, unknown>) {
    const selector = stringParam(params, 'selector')
    const path = resolve(stringParam(params, 'path'))
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    await execution.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dirname(path), eventsEnabled: true })
    await this.callHelper(execution, 'download', { selector: this.resolveElement(execution, selector), path })
    if (!existsSync(path)) throw fault('browser_timeout', 'the requested download did not produce its destination file')
    return { path }
  }

  private console(execution: PageExecution, params: Record<string, unknown>) {
    const limit = params.limit === undefined ? undefined : numberParam(params, 'limit')
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw fault('invalid_argument', 'console limit must be a positive integer')
    const entries = execution.runtimePage.consoleEntries
    return { entries: limit === undefined ? [...entries] : entries.slice(-limit), truncated: limit !== undefined && entries.length > limit }
  }

  private network(execution: PageExecution, params: Record<string, unknown>) {
    const limit = params.limit === undefined ? undefined : numberParam(params, 'limit')
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw fault('invalid_argument', 'network limit must be a positive integer')
    const entries = execution.runtimePage.networkEntries
    return { entries: limit === undefined ? [...entries] : entries.slice(-limit), truncated: limit !== undefined && entries.length > limit }
  }

  private captureStart(execution: PageExecution) {
    execution.runtimePage.captureStartedAt = Date.now() / 1000
    execution.runtimePage.harEntries = []
    return { capturing: true }
  }

  private captureStop(execution: PageExecution) {
    execution.runtimePage.captureStartedAt = undefined
    const entries = execution.runtimePage.harEntries.map((entry) => this.publicHarEntry(entry))
    return { stopped: true, har: { log: { version: '1.2', creator: { name: 'quirky.browser', version: '0.1.0' }, entries } } }
  }

  private async interceptEnable(execution: PageExecution, params: Record<string, unknown>) {
    const patterns = params.patterns === undefined ? ['**/*'] : params.patterns
    if (!Array.isArray(patterns) || patterns.length === 0 || !patterns.every((pattern) => typeof pattern === 'string' && pattern.length > 0)) {
      throw fault('invalid_argument', 'interception patterns must be a non-empty array of non-empty strings')
    }
    const list = patterns as string[]
    const settings = this.runtime.pageSettings(execution.page.browserPageId)
    await execution.cdp.send('Fetch.enable', {
      patterns: list.map((urlPattern) => ({ urlPattern: urlPattern.replaceAll('**', '*'), requestStage: 'Request' })),
      ...(settings.credentials ? { handleAuthRequests: true } : {})
    }, execution.binding.sessionId)
    this.runtime.updatePageSettings(execution.page.browserPageId, (current) => { current.routes = [...list] })
    return { enabled: true, patterns: list }
  }

  private async interceptDisable(execution: PageExecution) {
    const settings = this.runtime.pageSettings(execution.page.browserPageId)
    if (settings.credentials) await execution.cdp.send('Fetch.enable', { handleAuthRequests: true }, execution.binding.sessionId)
    else await execution.cdp.send('Fetch.disable', {}, execution.binding.sessionId)
    this.runtime.updatePageSettings(execution.page.browserPageId, (current) => { current.routes = [] })
    return { disabled: true }
  }

  private interceptList(execution: PageExecution) {
    const patterns = this.runtime.pageSettings(execution.page.browserPageId).routes
    return { patterns: [...patterns], requests: [...execution.runtimePage.interceptRequests] }
  }

  private async cookieGet(execution: PageExecution, params: Record<string, unknown>) {
    const transport = await this.runtime.cookieTransportLocked(execution.page.profileId)
    const cookies = await transport.list(execution.page.profileId)
    const urlValue = optionalString(params, 'url')
    if (urlValue === undefined) return { cookies }
    const url = this.absoluteUrl(urlValue, false)
    return { cookies: cookies.filter((cookie) => this.cookieAppliesToUrl(cookie, url)) }
  }

  private async cookieSet(execution: PageExecution, params: Record<string, unknown>) {
    const name = stringParam(params, 'name')
    const value = stringParam(params, 'value', true)
    const requestedUrl = optionalString(params, 'url')
    const selected = requestedUrl === undefined ? execution.page.url : requestedUrl
    const url = this.absoluteUrl(selected, false)
    const suppliedDomain = optionalString(params, 'domain')
    const domain = suppliedDomain === undefined ? url.hostname : this.cookieDomain(suppliedDomain)
    const cookiePath = optionalString(params, 'path')
    if (cookiePath === '') throw fault('invalid_argument', 'cookie path must not be empty')
    const partitionKey = partitionKeyParam(params.partitionKey)
    const cookie: Cookie = {
      name,
      value,
      domain: suppliedDomain === undefined ? domain : `.${domain.replace(/^\./, '')}`,
      path: cookiePath ?? '/',
      secure: params.secure === true,
      httpOnly: params.httpOnly === true,
      hostOnly: suppliedDomain === undefined,
      ...(params.sameSite === undefined ? {} : { sameSite: params.sameSite as SameSite }),
      ...(params.expires === undefined ? {} : { expires: numberParam(params, 'expires') }),
      ...(partitionKey === undefined ? {} : { partitionKey })
    }
    const transport = await this.runtime.cookieTransportLocked(execution.page.profileId)
    await transport.set(execution.page.profileId, cookie)
    return { success: true }
  }

  private async cookieDelete(execution: PageExecution, params: Record<string, unknown>) {
    const name = stringParam(params, 'name')
    const domainValue = optionalString(params, 'domain')
    const path = optionalString(params, 'path')
    if (path === '') throw fault('invalid_argument', 'cookie path must not be empty')
    const urlValue = optionalString(params, 'url')
    const partition = partitionKeyParam(params.partitionKey)
    const domain = domainValue === undefined ? undefined : this.cookieDomain(domainValue)
    const url = urlValue === undefined ? undefined : this.absoluteUrl(urlValue, false)
    const transport = await this.runtime.cookieTransportLocked(execution.page.profileId)
    const matches = (await transport.list(execution.page.profileId)).filter((cookie) =>
      cookie.name === name &&
      (domain === undefined || cookie.domain === domain || cookie.domain.replace(/^\./, '') === domain.replace(/^\./, '')) &&
      (path === undefined || cookie.path === path) &&
      (partition === undefined ? cookie.partitionKey === undefined : samePartition(cookie.partitionKey, partition)) &&
      (url === undefined || this.cookieAppliesToUrl(cookie, url))
    )
    if (matches.length > 1) throw fault('invalid_argument', 'cookie selection is ambiguous; specify domain, path, URL, or partition key')
    if (matches.length === 0) return { deleted: false }
    await transport.delete(execution.page.profileId, matches[0]!)
    return { deleted: true }
  }

  private async storage(execution: PageExecution, params: Record<string, unknown>, area: 'local' | 'session', operation: 'get' | 'set' | 'clear') {
    const key = params.key === undefined ? undefined : stringParam(params, 'key')
    const value = params.value === undefined ? undefined : stringParam(params, 'value', true)
    const escapedArea = area === 'local' ? 'localStorage' : 'sessionStorage'
    if (operation === 'get') {
      if (key === undefined) throw fault('invalid_argument', 'storage key is required')
      const script = `(()=>{const key=${JSON.stringify(key)};return {key,value:${escapedArea}.getItem(key)}})()`
      const result = await this.evaluateScript(execution, script)
      const data = this.dataObject({ result }, { type: 'object', properties: { result: { type: 'object', properties: { key: { type: 'string' }, value: {} }, required: ['key', 'value'], additionalProperties: true } }, required: ['result'], additionalProperties: true }, 'storage result')
      return data.result
    }
    if (operation === 'set') {
      if (key === undefined || value === undefined) throw fault('invalid_argument', 'storage key and value are required')
      const script = `(()=>{const key=${JSON.stringify(key)};const value=${JSON.stringify(value)};${escapedArea}.setItem(key,value);return {key,value}})()`
      return await this.evaluateScript(execution, script)
    }
    await this.evaluateScript(execution, `${escapedArea}.clear();true`)
    return { cleared: true }
  }

  private async viewport(execution: PageExecution, params: Record<string, unknown>) {
    const width = numberParam(params, 'width')
    const height = numberParam(params, 'height')
    const deviceScaleFactor = numberParam(params, 'deviceScaleFactor', 1)
    const mobile = params.mobile === true
    if (width <= 0 || height <= 0 || deviceScaleFactor <= 0) throw fault('invalid_argument', 'viewport dimensions and scale must be positive')
    await execution.cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.round(width), height: Math.round(height), deviceScaleFactor, mobile }, execution.binding.sessionId)
    this.runtime.updatePageSettings(execution.page.browserPageId, (settings) => {
      settings.viewport = { width, height, deviceScaleFactor, mobile }
      settings.deviceName = undefined
      settings.userAgent = undefined
    })
    return { width, height, deviceScaleFactor, mobile }
  }

  private async geolocation(execution: PageExecution, params: Record<string, unknown>) {
    const latitude = numberParam(params, 'latitude')
    const longitude = numberParam(params, 'longitude')
    const accuracy = numberParam(params, 'accuracy', 0)
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || accuracy < 0) throw fault('invalid_argument', 'geolocation is outside its valid range')
    const origin = this.absoluteUrl(execution.page.url, false).origin
    if (origin !== 'null') await execution.cdp.send('Browser.setPermission', { origin, permission: { name: 'geolocation' }, setting: 'granted' })
    await execution.cdp.send('Emulation.setGeolocationOverride', { latitude, longitude, accuracy }, execution.binding.sessionId)
    this.runtime.updatePageSettings(execution.page.browserPageId, (settings) => { settings.geolocation = { latitude, longitude, accuracy } })
    return { latitude, longitude, accuracy }
  }

  private async setDevice(execution: PageExecution, params: Record<string, unknown>) {
    const name = stringParam(params, 'name')
    const device = browserDevice(name)
    if (!device) throw fault('invalid_argument', `unknown device ${name}`)
    const viewport = { width: device.width, height: device.height, deviceScaleFactor: device.scale, mobile: true }
    await execution.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: true
    }, execution.binding.sessionId)
    await execution.cdp.send('Emulation.setUserAgentOverride', { userAgent: device.userAgent }, execution.binding.sessionId)
    this.runtime.updatePageSettings(execution.page.browserPageId, (settings) => {
      settings.deviceName = name
      settings.viewport = viewport
      settings.userAgent = device.userAgent
    })
    return { name }
  }

  private async setOffline(execution: PageExecution, params: Record<string, unknown>) {
    const current = this.runtime.pageSettings(execution.page.browserPageId).offline
    const state = params.state
    const offline = state === undefined ? !current : state === 'on'
    if (state !== undefined && state !== 'on' && state !== 'off') throw fault('invalid_argument', 'offline state must be on or off')
    await execution.cdp.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: offline ? 0 : -1, uploadThroughput: offline ? 0 : -1, connectionType: offline ? 'none' : 'wifi' }, execution.binding.sessionId)
    this.runtime.updatePageSettings(execution.page.browserPageId, (settings) => { settings.offline = offline })
    return { offline }
  }

  private async setHeaders(execution: PageExecution, params: Record<string, unknown>) {
    const text = stringParam(params, 'headers')
    let parsed: unknown
    try { parsed = JSON.parse(text) as unknown } catch { throw fault('invalid_argument', 'headers must be a JSON object with string-valued headers') }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw fault('invalid_argument', 'headers must be a JSON object with string-valued headers')
    const headers: Record<string, string> = Object.create(null)
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') throw fault('invalid_argument', 'headers must be a JSON object with string-valued headers')
      headers[name] = value
    }
    await execution.cdp.send('Network.setExtraHTTPHeaders', { headers }, execution.binding.sessionId)
    this.runtime.updatePageSettings(execution.page.browserPageId, (settings) => { settings.headers = headers })
    return { headers }
  }

  private async setCredentials(execution: PageExecution, params: Record<string, unknown>) {
    const user = stringParam(params, 'user')
    const pass = stringParam(params, 'pass', true)
    const settings = this.runtime.pageSettings(execution.page.browserPageId)
    await execution.cdp.send('Fetch.enable', {
      ...(settings.routes.length > 0 ? { patterns: settings.routes.map((urlPattern) => ({ urlPattern: urlPattern.replaceAll('**', '*'), requestStage: 'Request' })) } : {}),
      handleAuthRequests: true
    }, execution.binding.sessionId)
    this.runtime.updatePageSettings(execution.page.browserPageId, (current) => { current.credentials = { user, pass } })
    return { configured: true }
  }

  private async setMedia(execution: PageExecution, params: Record<string, unknown>) {
    const colorScheme = optionalString(params, 'colorScheme')
    const reducedMotion = optionalString(params, 'reducedMotion')
    if (colorScheme === undefined && reducedMotion === undefined) throw fault('invalid_argument', 'set media requires a color scheme or reduced-motion value')
    if (colorScheme !== undefined && colorScheme !== 'dark' && colorScheme !== 'light') throw fault('invalid_argument', 'color scheme must be dark or light')
    if (reducedMotion !== undefined && reducedMotion !== 'reduce' && reducedMotion !== 'no-preference') throw fault('invalid_argument', 'reduced motion must be reduce or no-preference')
    const current = this.runtime.pageSettings(execution.page.browserPageId)
    const nextColor = colorScheme === undefined ? current.colorScheme ?? null : colorScheme
    const nextMotion = reducedMotion === undefined ? current.reducedMotion ?? null : reducedMotion
    await execution.cdp.send('Emulation.setEmulatedMedia', { features: [
      ...(nextColor === null ? [] : [{ name: 'prefers-color-scheme', value: nextColor }]),
      ...(nextMotion === null ? [] : [{ name: 'prefers-reduced-motion', value: nextMotion }])
    ] }, execution.binding.sessionId)
    this.runtime.updatePageSettings(execution.page.browserPageId, (settings) => {
      settings.colorScheme = nextColor
      settings.reducedMotion = nextMotion
    })
    return { colorScheme: nextColor, reducedMotion: nextMotion }
  }

  private async clipboard(execution: PageExecution, text: string | undefined) {
    const url = this.absoluteUrl(execution.page.url, false)
    await execution.cdp.send('Browser.grantPermissions', {
      origin: url.origin,
      permissions: [
        'clipboardReadWrite',
        'clipboardSanitizedWrite',
        ...(execution.settings.geolocation ? ['geolocation'] : [])
      ]
    })
    if (text === undefined) {
      const value = await this.evaluateScript(execution, 'navigator.clipboard.readText()')
      if (typeof value !== 'string') throw fault('browser_error', 'Chromium clipboard returned a non-text value')
      return { text: value }
    }
    if (Buffer.byteLength(text, 'utf8') > 8 * 1024) throw fault('invalid_argument', 'clipboard text exceeds the 8 KiB limit')
    await this.evaluateScript(execution, `navigator.clipboard.writeText(${JSON.stringify(text)}).then(()=>true)`)
    return { written: true }
  }

  private async callHelper(execution: PageExecution, action: string, fields: Record<string, unknown> = {}, timeoutMs = 90_000) {
    const response = await execution.native(action, fields, timeoutMs)
    if (!response.success) this.helperFailure(response.error, action)
    return response
  }

  private async callHelperData(execution: PageExecution, action: string, fields: Record<string, unknown> = {}) {
    const response = await this.callHelper(execution, action, fields)
    return this.dataObject(response.data, HELPER_OBJECT_SCHEMA, `${action} result`)
  }


  private dataValue(data: Record<string, unknown>, description: string): unknown {
    if (Object.hasOwn(data, 'value')) return data.value
    if (Object.hasOwn(data, 'result')) return data.result
    throw fault('browser_error', `native browser did not return a ${description} value`)
  }

  private helperFailure(message: string | undefined, action: string): never {
    if (message?.toLowerCase().includes('timeout') || message?.toLowerCase().includes('timed out')) throw fault('browser_timeout', `${action} timed out`)
    if (action === 'evaluate') throw fault('browser_eval_error', 'page evaluation failed or returned a non-serializable value')
    throw fault('browser_error', `native browser action ${action} failed`)
  }

  private evaluateScript(execution: PageExecution, script: string): Promise<JsonValue> {
    return this.evaluateExpression(execution, script)
  }

  private async evaluateExpression(execution: PageExecution, script: string): Promise<JsonValue> {
    const response = await execution.native('evaluate', { script }, 90_000)
    if (!response.success) this.helperFailure(response.error, 'evaluate')
    const data = this.dataObject(response.data, { type: 'object', properties: { result: {} }, required: ['result'], additionalProperties: true }, 'evaluation result')
    return data.result as JsonValue
  }

  private resolveElement(execution: PageExecution, selector: string): string {
    if (selector.startsWith('qbr1:')) {
      const token = /^qbr1:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([1-9][0-9]*)$/.exec(selector)
      const ref = this.refs.get(selector)
      const projection = this.projections.get(execution.page.browserPageId)
      if (!token || !ref || !projection || ref.pageId !== execution.page.browserPageId || ref.projectionId !== token[1] || projection.id !== token[1] || ref.generation !== execution.binding.pageGeneration || projection.generation !== execution.binding.pageGeneration) {
        throw fault('browser_stale_ref', 'snapshot reference is stale or belongs to another page')
      }
      return ref.helperRef
    }
    if (selector.startsWith('@')) throw fault('browser_stale_ref', 'raw helper element references are private and cannot be used')
    return selector
  }


  private dataObject(data: unknown, schema: Schema, description: string): Record<string, unknown> {
    const failure = validateValue(schema, data, description)
    if (failure) throw fault('browser_error', `browser returned invalid ${description}`)
    return data as Record<string, unknown>
  }

  private absoluteUrl(value: string, navigation: boolean): URL {
    try {
      const url = new URL(value)
      if (navigation && url.protocol === 'about:' && value === 'about:blank') return url
      if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') throw new Error('unsupported scheme')
      return url
    } catch {
      throw fault('invalid_argument', navigation ? 'URL must be absolute HTTP, HTTPS, file, or exactly about:blank' : 'URL must be an absolute HTTP, HTTPS, or file URL')
    }
  }

  private cookieDomain(value: string): string {
    const candidate = value.trim().replace(/^\.+/, '').toLowerCase()
    if (candidate === '' || /[/\\@?#%]/.test(candidate) || candidate.includes('..')) throw fault('invalid_argument', 'cookie domain is invalid')
    try { return new URL(`https://${candidate}/`).hostname } catch { throw fault('invalid_argument', 'cookie domain is invalid') }
  }

  private cookieAppliesToUrl(cookie: Cookie, url: URL): boolean {
    const host = url.hostname.toLowerCase()
    const domain = cookie.domain.replace(/^\./, '').toLowerCase()
    const domainMatch = cookie.hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`)
    const pathMatch = url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)
    return domainMatch && pathMatch && (!cookie.secure || url.protocol === 'https:')
  }

  private publicHarEntry(entry: JsonValue): JsonValue {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
    const copy = structuredClone(entry)
    delete (copy as Record<string, JsonValue>)._requestId
    delete (copy as Record<string, JsonValue>)._failure
    return copy
  }

}
