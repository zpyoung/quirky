import type {
  SessionOptionDescriptor,
  SessionOptionDisabledReason,
  SessionOptionSelectChoice,
  SessionOptionValue
} from '../../../../../shared/native-chat-session-options'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../../shared/agent-chat-permission-mode'

export const PLAN_MODE_VALUE = 'plan'

const LEAD_OPTION_IDS: readonly string[] = ['model', 'effort', AGENT_CHAT_PERMISSION_MODE_OPTION_ID]

/** The options the chip lists: model, effort and permission mode first, then whatever else the agent offers. */
export function settingDescriptors(
  snapshot: readonly SessionOptionDescriptor[]
): SessionOptionDescriptor[] {
  const rank = (id: string) => {
    const index = LEAD_OPTION_IDS.indexOf(id)
    return index === -1 ? LEAD_OPTION_IDS.length : index
  }
  return snapshot
    .filter((descriptor) => descriptor.action === undefined)
    .map((descriptor, order) => ({ descriptor, order }))
    .sort((a, b) => rank(a.descriptor.id) - rank(b.descriptor.id) || a.order - b.order)
    .map(({ descriptor }) => descriptor)
}

/** The choices a select lists; plan mode has its own switch, so the permission modes leave it out. */
export function visibleChoices(descriptor: SessionOptionDescriptor): SessionOptionSelectChoice[] {
  if (descriptor.kind.type !== 'select') {
    return []
  }
  return descriptor.kind.choices.filter(
    (choice) =>
      descriptor.id !== AGENT_CHAT_PERMISSION_MODE_OPTION_ID || choice.value !== PLAN_MODE_VALUE
  )
}

export function permissionModeDescriptor(
  snapshot: readonly SessionOptionDescriptor[]
): SessionOptionDescriptor | undefined {
  return snapshot.find((descriptor) => descriptor.id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
}

export function selectedChoice(
  descriptor: SessionOptionDescriptor
): SessionOptionSelectChoice | undefined {
  return descriptor.kind.type === 'select'
    ? descriptor.kind.choices.find((choice) => choice.value === descriptor.kind.currentValue)
    : undefined
}

export function planModeActive(snapshot: readonly SessionOptionDescriptor[]): boolean {
  const mode = permissionModeDescriptor(snapshot)
  return mode?.kind.type === 'select' && mode.kind.currentValue === PLAN_MODE_VALUE
}

/** The value that leaves plan mode: where the chat was before it, else the first other mode. */
export function modeAfterPlan(
  snapshot: readonly SessionOptionDescriptor[],
  previous: SessionOptionValue | null
): string | null {
  const mode = permissionModeDescriptor(snapshot)
  if (mode?.kind.type !== 'select') {
    return null
  }
  const others = mode.kind.choices.filter((choice) => choice.value !== PLAN_MODE_VALUE)
  const kept = others.find((choice) => choice.value === previous)
  return (kept ?? others[0])?.value ?? null
}

/** The chip's text: the model and effort in force, or the permission mode when neither is known. */
export function settingsSummary(snapshot: readonly SessionOptionDescriptor[]): string {
  const parts = ['model', 'effort'].flatMap((id) => {
    const descriptor = snapshot.find((candidate) => candidate.id === id)
    const choice = descriptor ? selectedChoice(descriptor) : undefined
    return choice ? [choice.label] : []
  })
  if (parts.length > 0) {
    return parts.join(' · ')
  }
  const mode = permissionModeDescriptor(snapshot)
  return (mode && selectedChoice(mode)?.label) ?? 'Settings'
}

export function disabledReasonText(reason: SessionOptionDisabledReason | undefined): string {
  if (reason === 'available-after-session-start') {
    return 'Available once the session starts'
  }
  return reason === 'set-when-session-starts'
    ? 'Set when the session starts'
    : 'Not available right now'
}
