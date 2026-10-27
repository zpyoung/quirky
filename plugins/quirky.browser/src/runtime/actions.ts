import { randomUUID } from 'node:crypto'
import { validateValue, type Schema } from '@quirky/protocol'
import { BrowserFault, fault } from './errors'
import { BrowserRuntime, type JsonValue, type PageExecution } from './driver'
import type { BrowserStore } from '../profiles/store'
import type { BrowserMethod } from './catalog'

type SnapshotRef = { ref: string; role: string; name: string }
type RefEntry = { pageId: string; projectionId: string; generation: number; helperRef: string }
type Projection = { id: string; generation: number; refs: SnapshotRef[] }

const HELPER_OBJECT_SCHEMA: Schema = { type: 'object', additionalProperties: true }
const SNAPSHOT_SCHEMA: Schema = {
  type: 'object',
  properties: {
    snapshot: { type: 'string' },
    refs: { type: 'object', additionalProperties: true },
    url: { type: 'string' },
    title: { type: 'string' }
  },
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

function stringParam(params: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = params[key]
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw fault('invalid_argument', `${key} must be a ${allowEmpty ? 'string' : 'non-empty string'}`)
  }
  return value
}

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
      case 'screenshot': return await this.screenshot(execution, params)
      case 'goto': return await this.goto(execution, stringParam(params, 'url'))
      case 'eval': return await this.evaluate(execution, params)
      case 'fill': return await this.elementAction(execution, method, params)
      case 'click': return await this.elementAction(execution, method, params)
      default: throw fault('browser_error', `no page action implementation exists for ${method}`)
    }
  }

  private async snapshot(execution: PageExecution) {
    const pageId = execution.page.browserPageId
    this.clearPageRefs(pageId)
    const response = await this.callHelper(execution, 'snapshot')
    const data = this.dataObject(response.data, SNAPSHOT_SCHEMA, 'snapshot')
    const rawRefs = data.refs as Record<string, unknown>
    const projectionId = randomUUID()
    const refs: SnapshotRef[] = []
    for (const [index, [helperRef, raw]] of Object.entries(rawRefs).entries()) {
      if (!/^e[1-9]\d*$/.test(helperRef)) throw fault('browser_tab_changed', 'snapshot helper returned an invalid private reference')
      const value = this.dataObject(raw, SNAPSHOT_REF_SCHEMA, 'snapshot reference')
      const token = `qbr1:${projectionId}:${index + 1}`
      const ref: SnapshotRef = {
        ref: token,
        role: typeof value.role === 'string' ? value.role : '',
        name: typeof value.name === 'string' ? value.name : ''
      }
      refs.push(ref)
      this.refs.set(token, {
        pageId,
        projectionId,
        generation: execution.binding.pageGeneration,
        helperRef: `@${helperRef}`
      })
    }
    const previous = this.projections.get(pageId)
    if (previous) for (const ref of previous.refs) this.refs.delete(ref.ref)
    this.projections.set(pageId, { id: projectionId, generation: execution.binding.pageGeneration, refs })
    const location = await this.runtime.pageLocation(execution)
    return {
      browserPageId: pageId,
      projectionId,
      url: location.url,
      title: location.title,
      snapshot: data.snapshot as string,
      refs
    }
  }

  private async screenshot(execution: PageExecution, params: Record<string, unknown>) {
    const format = params.format === 'jpeg' ? 'jpeg' : 'png'
    const captured = this.dataObject(
      await execution.cdp.send('Page.captureScreenshot', { format, fromSurface: true, captureBeyondViewport: false }, execution.binding.sessionId),
      CAPTURE_SCHEMA,
      'screenshot'
    )
    return { data: captured.data as string, format }
  }

  private async goto(execution: PageExecution, url: string) {
    this.absoluteUrl(url)
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
      record.loadError = result.errorText
        ? { code: 'navigation_failed', description: result.errorText.slice(0, 300), validatedUrl: url }
        : null
    })
    if (result.errorText) throw fault('browser_error', `navigation failed: ${result.errorText}`)
    return { url: page.url, title: page.title }
  }

  private async elementAction(execution: PageExecution, method: 'click' | 'fill', params: Record<string, unknown>) {
    const supplied = stringParam(params, 'element')
    const fields: Record<string, unknown> = { selector: this.resolveElement(execution, supplied) }
    if (method === 'fill') fields.value = stringParam(params, 'value', true)
    await this.callHelper(execution, method, fields)
    return method === 'click' ? { clicked: supplied } : { filled: supplied }
  }

  private async evaluate(execution: PageExecution, params: Record<string, unknown>) {
    const response = await execution.native('evaluate', { script: stringParam(params, 'expression') }, 90_000)
    if (!response.success) throw fault('browser_eval_error', 'page evaluation failed or returned a non-serializable value')
    const data = this.dataObject(response.data, HELPER_OBJECT_SCHEMA, 'evaluation response')
    if (data.result === undefined) throw fault('browser_eval_error', 'page evaluation did not return a serializable JSON value')
    return { value: data.result as JsonValue }
  }

  private async callHelper(execution: PageExecution, action: string, fields: Record<string, unknown> = {}) {
    const response = await execution.native(action, fields)
    if (!response.success) {
      if (response.error?.toLowerCase().includes('timeout') || response.error?.toLowerCase().includes('timed out')) {
        throw fault('browser_timeout', `${action} timed out`)
      }
      throw fault('browser_error', `native browser action ${action} failed`)
    }
    return response
  }

  private resolveElement(execution: PageExecution, selector: string): string {
    if (selector.startsWith('qbr1:')) {
      const token = /^qbr1:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([1-9][0-9]*)$/.exec(selector)
      const ref = this.refs.get(selector)
      const projection = this.projections.get(execution.page.browserPageId)
      if (!token || !ref || !projection || ref.pageId !== execution.page.browserPageId || ref.projectionId !== token[1] ||
        projection.id !== token[1] || ref.generation !== execution.binding.pageGeneration || projection.generation !== execution.binding.pageGeneration) {
        throw fault('browser_stale_ref', 'snapshot reference is stale or belongs to another page')
      }
      return ref.helperRef
    }
    if (selector.startsWith('@')) throw fault('browser_stale_ref', 'raw helper element references are private and cannot be used')
    return selector
  }

  private dataObject(data: unknown, schema: Schema, description: string): Record<string, unknown> {
    if (validateValue(schema, data, description)) throw fault('browser_error', `browser returned invalid ${description}`)
    return data as Record<string, unknown>
  }

  private absoluteUrl(value: string): URL {
    try {
      const url = new URL(value)
      if (url.protocol === 'about:' && value === 'about:blank') return url
      if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') throw new Error('unsupported scheme')
      return url
    } catch {
      throw fault('invalid_argument', 'URL must be absolute HTTP, HTTPS, file, or exactly about:blank')
    }
  }
}
