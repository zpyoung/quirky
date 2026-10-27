import type { PluginContext } from '@quirky/protocol'
import { SessionInfoService, SESSION_INFO_MIGRATIONS } from './src/service'

let service: SessionInfoService | undefined

export function activate(context: PluginContext): void {
  const active = new SessionInfoService(context, context.openStore(SESSION_INFO_MIGRATIONS))
  service = active

  context.provide('method:quirky.session-info/get', (params: Record<string, unknown>) => active.get(params))
  context.provide('method:quirky.session-info/sections', (params: Record<string, unknown>) => active.sections(params))
  context.provide('method:quirky.session-info/inspect', (params: Record<string, unknown>) => active.inspect(params))
  context.provide('method:quirky.session-info/telemetry', (params: Record<string, unknown>) => active.telemetry(params))
  context.provide('method:quirky.session-info/enableTelemetry', (params: Record<string, unknown>) => active.enableTelemetry(params))
  context.provide('method:quirky.session-info/history', (params: Record<string, unknown>) => active.history(params))
  context.provide('method:quirky.session-info/transcript', (params: Record<string, unknown>) => active.transcript(params))
  context.provide('method:quirky.session-info/resumeCommand', (params: Record<string, unknown>) => active.resumeCommand(params))
  context.provide('launch-hook:quirky.session-info/statusline', (input: unknown) => active.launchHook(input))

  active.start()
}

export function deactivate(): void {
  service?.shutdown()
  service = undefined
}
