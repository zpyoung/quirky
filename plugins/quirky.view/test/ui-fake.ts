import { act } from 'react'
import { RpcError, RpcErrorCode, type QuirkyEvent, type UiPluginContext } from '@quirky/protocol'
import type { ViewPlacement, ViewRecord, ViewSpec } from '../src/core/catalog'

type Handler = (params: Record<string, any>) => unknown

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
  const calls: { method: string; params: Record<string, any> }[] = []
  const provided = new Map<string, (...args: any[]) => any>()
  const listeners = new Set<(event: QuirkyEvent) => void>()
  const toasts: { title: string; body: string }[] = []

  const context = {
    pluginId: 'quirky.view',
    log() {},
    provide(id: string, implementation: unknown) {
      provided.set(id, implementation as (...args: any[]) => any)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const handler = handlers[method]
      if (!handler) throw new RpcError(RpcErrorCode.MethodNotFound, `unknown method: ${method}`)
      return handler(params)
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
    callsTo: (method: string) => calls.filter((call) => call.method === method),
    emit: (event: { type: string; data?: unknown }) => act(async () => void listeners.forEach((listener) => listener(event as unknown as QuirkyEvent)))
  }
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Mounts a provided view on a fresh element of the document with `input`. */
export async function mountView(fake: FakeContext, id: string, input: unknown) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  let unmount: (() => void) | void = undefined
  await act(async () => {
    unmount = fake.provided.get(id)!(element, { input })
  })
  await settle()
  return {
    element,
    click: (target: Element) => act(async () => void target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))),
    unmount: () => act(async () => void (unmount as (() => void) | undefined)?.())
  }
}
