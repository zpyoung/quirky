import type { UiPluginContext } from '@quirky/protocol'

export const PROJECTS_CONTROL_COMMAND = 'command:quirky.tasks/projects-control'

export type ProjectsControlRequest =
  | { action: 'picker'; open?: boolean }
  | { action: 'column-panel'; open?: boolean }
  | { action: 'back-to-picker' }
  | { action: 'column'; fieldId: string; visible?: boolean; width?: number }
  | { action: 'sort'; fieldId: string }
  | { action: 'group'; group: string }
  | { action: 'zoom'; zoom: 'month' | 'quarter' | 'year' }
  | { action: 'today' }
  | { action: 'edit'; itemId: string; fieldId: string; open: boolean }

export type ProjectsControlResult = { delivered: number }
/** Returns true when this mounted Projects view applied the request. */
export type ProjectsControlHandler = (request: ProjectsControlRequest) => boolean
const CONNECTION_CHANGED_ERROR = 'The window connection changed while identifying this window.'

type ProjectsControlDescriptor = { command: typeof PROJECTS_CONTROL_COMMAND; args: ProjectsControlRequest }

const registrations = new WeakMap<UiPluginContext, Set<ProjectsControlHandler>>()

export function parseProjectsControlRequest(input: unknown): ProjectsControlRequest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('projects-control needs an action of picker, column-panel, back-to-picker, column, sort, group, zoom, today or edit.')
  }
  const raw = input as Record<string, unknown>
  if (raw.action !== 'picker' && raw.action !== 'column-panel' && raw.action !== 'back-to-picker' && raw.action !== 'column' &&
    raw.action !== 'sort' && raw.action !== 'group' && raw.action !== 'zoom' && raw.action !== 'today' && raw.action !== 'edit') {
    throw new Error('projects-control needs an action of picker, column-panel, back-to-picker, column, sort, group, zoom, today or edit.')
  }

  if (raw.action === 'picker' || raw.action === 'column-panel') {
    if (Object.keys(raw).some((key) => key !== 'action' && key !== 'open')) {
      throw new Error(`projects-control ${raw.action} takes only an optional boolean open.`)
    }
    if (Object.hasOwn(raw, 'open') && typeof raw.open !== 'boolean') {
      throw new Error('projects-control open must be a boolean.')
    }
    return Object.hasOwn(raw, 'open') ? { action: raw.action, open: raw.open as boolean } : { action: raw.action }
  }

  if (raw.action === 'back-to-picker') {
    if (Object.keys(raw).some((key) => key !== 'action')) {
      throw new Error('projects-control back-to-picker takes no other fields.')
    }
    return { action: 'back-to-picker' }
  }

  if (raw.action === 'sort') {
    if (typeof raw.fieldId !== 'string' || !raw.fieldId.trim() || Object.keys(raw).some((key) => key !== 'action' && key !== 'fieldId')) {
      throw new Error('projects-control sort needs a nonempty fieldId and no other fields.')
    }
    return { action: 'sort', fieldId: raw.fieldId }
  }
  if (raw.action === 'group') {
    if (typeof raw.group !== 'string' || !raw.group.trim() || Object.keys(raw).some((key) => key !== 'action' && key !== 'group')) {
      throw new Error('projects-control group needs a nonempty group and no other fields.')
    }
    return { action: 'group', group: raw.group }
  }
  if (raw.action === 'zoom') {
    if ((raw.zoom !== 'month' && raw.zoom !== 'quarter' && raw.zoom !== 'year') || Object.keys(raw).some((key) => key !== 'action' && key !== 'zoom')) {
      throw new Error('projects-control zoom needs month, quarter or year and no other fields.')
    }
    return { action: 'zoom', zoom: raw.zoom }
  }
  if (raw.action === 'today') {
    if (Object.keys(raw).some((key) => key !== 'action')) throw new Error('projects-control today takes no other fields.')
    return { action: 'today' }
  }
  if (raw.action === 'edit') {
    if (typeof raw.itemId !== 'string' || !raw.itemId.trim() || typeof raw.fieldId !== 'string' || !raw.fieldId.trim() ||
      typeof raw.open !== 'boolean' || Object.keys(raw).some((key) => key !== 'action' && key !== 'itemId' && key !== 'fieldId' && key !== 'open')) {
      throw new Error('projects-control edit needs nonempty itemId and fieldId strings, a boolean open and no other fields.')
    }
    return { action: 'edit', itemId: raw.itemId, fieldId: raw.fieldId, open: raw.open }
  }

  const validField = typeof raw.fieldId === 'string' && raw.fieldId.trim().length > 0
  const hasVisible = Object.hasOwn(raw, 'visible')
  const hasWidth = Object.hasOwn(raw, 'width')
  const validVisible = !hasVisible || typeof raw.visible === 'boolean'
  const validWidth = !hasWidth || (typeof raw.width === 'number' && Number.isInteger(raw.width) && raw.width >= 60 && raw.width <= 800)
  const hasOnlyColumnFields = Object.keys(raw).every((key) => ['action', 'fieldId', 'visible', 'width'].includes(key))
  if (!validField || !validVisible || !validWidth || !hasOnlyColumnFields || (!hasVisible && !hasWidth)) {
    throw new Error('projects-control column needs a fieldId and a visible boolean or a width from 60 to 800.')
  }
  if (raw.fieldId === 'title' && raw.visible === false) throw new Error('The Title column cannot be hidden.')
  return {
    action: 'column',
    fieldId: raw.fieldId as string,
    ...(hasVisible ? { visible: raw.visible as boolean } : {}),
    ...(hasWidth ? { width: raw.width as number } : {})
  }
}

export function registerProjectsControl(context: UiPluginContext, handler: ProjectsControlHandler): () => void {
  let handlers = registrations.get(context)
  if (!handlers) {
    handlers = new Set()
    registrations.set(context, handlers)
  }
  handlers.add(handler)
  return () => {
    handlers!.delete(handler)
    if (handlers!.size === 0) registrations.delete(context)
  }
}

export function runProjectsControl(context: UiPluginContext, input: unknown): ProjectsControlResult {
  const request = parseProjectsControlRequest(input)
  let delivered = 0
  for (const handler of registrations.get(context) ?? []) if (handler(request)) delivered += 1
  return { delivered }
}

export function projectsControlDescriptor(request: ProjectsControlRequest): ProjectsControlDescriptor {
  return { command: PROJECTS_CONTROL_COMMAND, args: request }
}

export async function requestProjectsControl(context: UiPluginContext, request: ProjectsControlRequest): Promise<void> {
  let connectionChanged = false
  const unsubscribe = context.onConnection(() => { connectionChanged = true })
  try {
    const response = await context.call('ui.window.self', {})
    if (connectionChanged) throw new Error(CONNECTION_CHANGED_ERROR)
    const connId = response !== null && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>).connId
      : undefined
    if (typeof connId !== 'number' || !Number.isSafeInteger(connId) || connId <= 0) {
      throw new Error('The daemon did not identify this window.')
    }
    const descriptor = projectsControlDescriptor(request)
    await context.call('ui.window.command.run', { connId, id: descriptor.command, args: descriptor.args })
  } finally {
    unsubscribe()
  }
}
