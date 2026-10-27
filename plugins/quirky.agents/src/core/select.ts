import type { AgentEntry } from './types'

export type PickInput = {
  /** The catalog in auto-pick order. */
  entries: AgentEntry[]
  installed: (id: string) => boolean
  disabled: (id: string) => boolean
  /** `auto`, `shell` or an agent ID; null counts as `auto`. */
  preferred: string | null
  /** True for the "New agent tab" command, which never falls back to a plain shell. */
  forAgentTab: boolean
}

/**
 * Chooses the agent a launch without an explicit agent starts: an installed, enabled preferred
 * agent, else the first installed, enabled entry in catalog order. Returns `shell` when nothing
 * fits (or the preference is `shell`), and null instead of `shell` for the agent tab.
 */
export function pickAgent(input: PickInput): string | null {
  const { entries, installed, disabled, preferred, forAgentTab } = input
  if (preferred === 'shell' && !forAgentTab) return 'shell'
  const usable = (id: string) => installed(id) && !disabled(id)

  if (preferred && preferred !== 'auto' && preferred !== 'shell') {
    if (entries.some((entry) => entry.id === preferred) && usable(preferred)) return preferred
  }
  for (const entry of entries) {
    if (usable(entry.id)) return entry.id
  }
  return forAgentTab ? null : 'shell'
}
