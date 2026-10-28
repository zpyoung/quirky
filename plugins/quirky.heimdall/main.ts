import type { PluginCaller, PluginContext } from '@quirky/protocol'
import type { EnrollmentInput, KindRegistration } from './src/contracts'
import { createKernelService, type KernelService } from './src/service'
import { installControls } from './src/control-main'
import { provideOwnerMethods } from './src/owner/api'

let activeService: KernelService | undefined
let activeControls: { dispose(): void } | undefined

export async function activate(context: PluginContext): Promise<void> {
  const service = createKernelService(context)
  activeService = service
  context.provide('method:quirky.heimdall/registerKind', (params: Record<string, unknown>, caller: PluginCaller) =>
    service.registerKind(params as unknown as KindRegistration, caller)
  )
  context.provide('method:quirky.heimdall/submissionPreflight', (params: Record<string, unknown>, caller: PluginCaller) =>
    service.submissionPreflight(params, caller)
  )
  context.provide('method:quirky.heimdall/enroll', (params: Record<string, unknown>) =>
    service.enroll(params as unknown as EnrollmentInput)
  )
  context.provide('method:quirky.heimdall/inspect', (params: Record<string, unknown>) =>
    service.inspect(typeof params.watcherId === 'string' ? params.watcherId : undefined)
  )
  context.provide('method:quirky.heimdall/reconcile', (params: Record<string, unknown>) =>
    service.reconcile(params.watcherId as string)
  )
  provideOwnerMethods(context, service, service.owner)
  try {
    await service.start()
    activeControls = await installControls(context, {
      store: service.store,
      inspect: watcherId => service.inspect(watcherId)[0] ?? null,
      runner: watcherId => service.runner(watcherId),
      changed: watcherId => service.changed(watcherId),
      reconcile: async watcherId => { await service.reconcile(watcherId) },
      forgetRunner: watcherId => service.forgetRunner(watcherId),
      releaseOwner: watcherId => service.owner.release(watcherId),
      answerOwnerEscalation: async (enrollment, escalationId, body) => {
        const result = await service.owner.answer(enrollment.watcherId, escalationId, body)
        if (result.reason === 'owner-answer-sent') return { kind: 'applied', appliedAtMs: Date.now() }
        if (result.handled) return { kind: 'indeterminate', detail: result.reason ?? 'Owner answer delivery is indeterminate' }
        return { kind: 'refused', reason: 'invalid-state', detail: result.reason ?? 'Owner rejected this exact escalation answer' }
      }
    })
  } catch (error) {
    activeControls?.dispose()
    activeControls = undefined
    activeService = undefined
    await service.shutdown()
    throw error
  }
}

export async function deactivate(): Promise<void> {
  activeControls?.dispose()
  activeControls = undefined
  const service = activeService
  activeService = undefined
  await service?.shutdown()
}
