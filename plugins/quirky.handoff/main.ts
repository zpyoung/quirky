import type { PluginContext } from '@quirky/protocol'
import { HandoffService } from './src/daemon/service'
import { migrations } from './src/daemon/store'

let service: HandoffService | undefined

/** Starts the session handoff plugin: its methods, its store, and the transcript path history. */
export function activate(context: PluginContext): void {
  const store = context.openStore(migrations)
  const active = new HandoffService(context, store)
  service = active

  const provide = (name: string, handler: (params: Record<string, unknown>) => unknown) =>
    context.provide(`method:quirky.handoff/${name}`, handler)
  provide('prepare', (params) => active.prepare(params))
  provide('openArchived', (params) => active.openArchived(params))
  provide('preview', (params) => active.preview(params))
  provide('probe', (params) => active.probe(params))
  provide('templates', () => active.templates())
  provide('templateMutate', (params) => active.templateMutate(params))
  provide('draft', (params) => active.draft(params))
  provide('start', (params) => active.start(params))
  provide('resend', (params) => active.resend(params))
  provide('discard', (params) => active.discard(params))
  provide('lineage', (params) => active.lineage(params))
  provide('jump', (params) => active.jump(params))
  active.activate()
}

export function deactivate(): void {
  service?.stop()
  service = undefined
}
