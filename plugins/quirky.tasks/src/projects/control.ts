import type { UiPluginContext } from '@quirky/protocol'

export const PROJECTS_CONTROL_COMMAND = 'command:quirky.tasks/projects-control'

export type ProjectsControlRequest =
  | { action: 'picker'; open?: boolean }
  | { action: 'column-panel'; open?: boolean }
  | { action: 'back-to-picker' }
  | { action: 'column'; fieldId: string; visible?: boolean; width?: number }

export type ProjectsControlResult = { delivered: number }
/** Returns true when this mounted Projects view applied the request. */
export type ProjectsControlHandler = (request: ProjectsControlRequest) => boolean
export type WindowConnection = { current: number | null }

type ProjectsControlDescriptor = { command: typeof PROJECTS_CONTROL_COMMAND; args: ProjectsControlRequest }

const registrations = new WeakMap<UiPluginContext, Set<ProjectsControlHandler>>()

export function parseProjectsControlRequest(input: unknown): ProjectsControlRequest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('projects-control needs an action of picker, column-panel, back-to-picker or column.')
  }
  const raw = input as Record<string, unknown>
  if (raw.action !== 'picker' && raw.action !== 'column-panel' && raw.action !== 'back-to-picker' && raw.action !== 'column') {
    throw new Error('projects-control needs an action of picker, column-panel, back-to-picker or column.')
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

export async function requestProjectsControl(context: UiPluginContext, connection: WindowConnection, request: ProjectsControlRequest): Promise<void> {
  if (connection.current === null) {
    const response = await context.call('ui.window.self', {})
    const connId = response !== null && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>).connId
      : undefined
    if (typeof connId !== 'number' || !Number.isSafeInteger(connId) || connId <= 0) {
      throw new Error('The daemon did not identify this window.')
    }
    connection.current = connId
  }
  const descriptor = projectsControlDescriptor(request)
  await context.call('ui.window.command.run', { connId: connection.current, id: descriptor.command, args: descriptor.args })
}
