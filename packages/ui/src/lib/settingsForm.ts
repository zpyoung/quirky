import type { Settings } from '@quirky/protocol'

export const SCROLLBACK_MIN = 500
export const SCROLLBACK_MAX = 10000

export type SettingsDraft = {
  worktreesRoot: string
  terminalScrollback: string
  notifications: boolean
}

export type PatchResult = { ok: true; patch: Settings } | { ok: false; error: string }

/** Validates the settings form and converts it into the `settings.set` payload. */
export function toSettingsPatch(draft: SettingsDraft): PatchResult {
  const worktreesRoot = draft.worktreesRoot.trim()
  if (!worktreesRoot) return { ok: false, error: 'Worktrees folder is required.' }
  const text = draft.terminalScrollback.trim()
  const lines = /^\d+$/.test(text) ? Number(text) : NaN
  if (!Number.isInteger(lines) || lines < SCROLLBACK_MIN || lines > SCROLLBACK_MAX) {
    return { ok: false, error: `Scrollback must be a whole number from ${SCROLLBACK_MIN} to ${SCROLLBACK_MAX}.` }
  }
  return {
    ok: true,
    patch: { worktreesRoot, terminalScrollback: lines, notifications: draft.notifications }
  }
}
