import { act } from 'react'
import { RpcError, RpcErrorCode, type CommandHandler, type MountFunction, type QuirkyEvent, type UiPluginContext } from '@quirky/protocol'
import type { ViewPlacement, ViewRecord, ViewSpec } from '../src/core/catalog'

type Handler = (params: Record<string, unknown>) => unknown
type ProvidedImplementation = CommandHandler | MountFunction

export type FakeContext = ReturnType<typeof fakeContext>

export function record(spec: ViewSpec, over: Partial<ViewRecord> = {}): ViewRecord {
  return {
    viewId: 'view_1',
    sessionId: 's1',
    title: spec.title,
    spec,
    placement: 'inline' as ViewPlacement,
    movedByUser: false,
    updates: 0,
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
    closed: false,
    ...over
  }
}

/** A `UiPluginContext` whose daemon calls are served by `handlers`; every other method rejects as unknown. */
export function fakeContext(handlers: Record<string, Handler> = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const commandCalls: { id: string; args?: unknown }[] = []
  const reports: unknown[] = []
  const provided = new Map<string, ProvidedImplementation>()
  const listeners = new Set<(event: QuirkyEvent) => void>()
  const toasts: { title: string; body: string }[] = []

  const context = {
    pluginId: 'quirky.view',
    log() {},
    provide(id: string, implementation: unknown) {
      provided.set(id, implementation as ProvidedImplementation)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const handler = handlers[method]
      if (!handler) throw new RpcError(RpcErrorCode.MethodNotFound, `unknown method: ${method}`)
      return handler(params)
    },
    executeCommand: async (id: string, args?: unknown) => {
      commandCalls.push({ id, args })
      const command = provided.get(id)
      if (typeof command !== 'function') throw new Error(`No command: ${id}`)
      await (command as CommandHandler)(args)
    },
    subscribe(listener: (event: QuirkyEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onConnection: () => () => {},
    toast(title: string, body: string) {
      toasts.push({ title, body })
    }
  } as unknown as UiPluginContext

  return {
    context,
    calls,
    provided,
    toasts,
    commandCalls,
    reports,
    callsTo: (method: string) => calls.filter((call) => call.method === method),
    routedTo: (id: string) => commandCalls.filter((call) => call.id === id),
    runCommand: async (id: string, args?: unknown) => {
      const command = provided.get(id)
      if (typeof command !== 'function') throw new Error(`No command: ${id}`)
      let result: unknown
      await act(async () => {
        result = await (command as CommandHandler)(args)
      })
      return result
    },
    emit: (event: { type: string; data?: unknown }) => act(async () => void listeners.forEach((listener) => listener(event as unknown as QuirkyEvent)))
  }
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Mounts a provided view on a fresh element, optionally capturing its host report. */
export async function mountView(fake: FakeContext, id: string, input: unknown, onReport?: (state: unknown) => void) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  let unmount: (() => void) | void = undefined
  const implementation = fake.provided.get(id)
  if (typeof implementation !== 'function') throw new Error(`No view: ${id}`)
  await act(async () => {
    unmount = (implementation as MountFunction)(element, {
      input,
      ...(onReport === undefined
        ? {}
        : {
            report: (state: unknown) => {
              fake.reports.push(state)
              onReport(state)
            }
          })
    })
  })
  await settle()
  return {
    element,
    click: (target: Element) => act(async () => void target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))),
    unmount: () => act(async () => void (unmount as (() => void) | undefined)?.())
  }
}
