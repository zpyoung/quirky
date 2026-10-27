export const PLUGIN_ID = 'quirky.handoff'
export const DIALOG_OVERLAY_ID = `overlay:${PLUGIN_ID}/dialog`
export const SETTINGS_VIEW_ID = `view:${PLUGIN_ID}/settings`

export const DIALOG_TITLE = 'Continue in New Session'
export const DIALOG_DESCRIPTION =
  'Review and customize the brief, destination, and delivery for a fresh Agent session. The source stays running.'
export const NO_CONTEXT_MESSAGE = 'No session context is available to continue in a new session.'

export const AGENTS_LOADING = 'Detecting Agents on the target host…'
export const AGENTS_FAILED = 'Could not detect Agents on the target host.'
export const AGENTS_EMPTY = 'No enabled Agents were detected on the target host.'

export const FULL_UNVERIFIABLE = 'A full saved transcript could not be verified on this target. Focused context will be used.'
export const FULL_UNREACHABLE = 'A full saved transcript is not reachable on this target. Focused context will be used.'

export const STALE_MESSAGE = 'The edited preview is stale relative to newer controls, target data, or session context.'
export const DETACHED_NOTICE = 'The preview is no longer auto-updating. Regenerating discards your edits.'
export const BUSY_MESSAGE = 'The source Agent is working. Capture now or wait for newer context.'
export const WAITING_MESSAGE = 'Waiting for the source session to go idle. You can still start now.'

export const RESEND_CONFIRM_TITLE = 'The brief may already have arrived. Sending again can create a duplicate turn.'

export const SETTINGS_SUBTITLE = 'Create reusable instructions for continuing work in a new Agent session.'
export const VARIABLES_HINT = 'Variables: {{gitStatus}}, {{changedPaths}}, and {{openEditorTabs}}. SCREAMING_CASE aliases also work.'

export const DEBOUNCE_MS = 150

export const secretsMarkerLine = (count: number): string =>
  `${count} potential secret markers are highlighted in the preview.`

export const BODY_COUNTER = (length: number, max: number): string => `${length.toLocaleString('en-US')} / ${max.toLocaleString('en-US')}`

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The machine reason a daemon error carries in `data.reason`, if any. */
export const reasonOf = (error: unknown): string | undefined => {
  const data = (error as { data?: { reason?: unknown } } | null)?.data
  return typeof data?.reason === 'string' ? data.reason : undefined
}
