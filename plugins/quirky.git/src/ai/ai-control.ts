import { useEffect, useRef } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { messageOf } from '../panel/format'
import { registerGitUiControl, requestGitUiControl } from '../ui-control'
import type { GitUiControl } from '../ui-control'

export const AI_PANEL_SURFACE = 'panel:quirky.git/source-control' as const

const UNAVAILABLE_ACTION = 'The source control action is no longer available.'
const DELIVERY_ERROR_TITLE = 'Could not run Source Control action'
let generationSequence = 0

/** Gives each mounted control session a fresh address token. */
export function aiControlGeneration(): string {
  generationSequence += 1
  return `ai-${generationSequence}`
}

/** Publishes committed AI controls with dispatch-time eligibility and mount-scoped cleanup. */
export function useAiControl(
  context: UiPluginContext,
  address: { target: string; generation: string; actions: string[] } | null,
  handler: (control: GitUiControl) => boolean
): void {
  const latestAddress = useRef(address)
  const latestHandler = useRef(handler)
  latestAddress.current = address
  latestHandler.current = handler

  const key = address === null
    ? null
    : JSON.stringify([address.target, address.generation, address.actions])

  useEffect(() => {
    const active = latestAddress.current
    if (active === null) return
    return registerGitUiControl(context, {
      surface: AI_PANEL_SURFACE,
      target: active.target,
      generation: active.generation,
      actions: active.actions
    }, (control) => latestHandler.current(control))
  }, [context, key])
}

/** Delivers one exact-window action, reporting refusal without retrying or running it locally. */
export async function requestAiControl(
  context: UiPluginContext,
  control: { target: string; generation: string; action: string; data?: Record<string, unknown> }
): Promise<boolean> {
  try {
    const result = await requestGitUiControl(context, { surface: AI_PANEL_SURFACE, ...control })
    if (result.delivered) return true
    context.toast(DELIVERY_ERROR_TITLE, UNAVAILABLE_ACTION, { kind: 'error' })
  } catch (error) {
    context.toast(DELIVERY_ERROR_TITLE, messageOf(error), { kind: 'error' })
  }
  return false
}
