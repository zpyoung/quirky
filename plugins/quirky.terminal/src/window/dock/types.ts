export type DockAttachment = { id: string; name: string; path: string; mime: string; image: boolean }

export type DockQuestion = {
  id: string
  kind: 'question' | 'permission'
  title: string
  questions: { prompt: string; choices: { label: string; value: string }[]; multiple: boolean }[]
  collapsed: boolean
  dismissed: boolean
}

export type DockOptions = {
  model: string | null
  effort: string | null
  permission: string | null
  choices: { model: string[]; effort: string[]; permission: string[] }
  context: { used: number; limit: number } | null
  notice: string | null
}

/** The public serialized state returned by quirky.terminal-dock; deliberately owned by this host. */
export type DockState = {
  pane: string
  session: string
  tab: string
  revision: number
  enabled: boolean
  supported: boolean
  agent: string | null
  docked: boolean
  userUndocked: boolean
  gutterRows: number
  mounted: boolean
  passthrough: boolean
  draft: string
  attachments: DockAttachment[]
  disabledReason: string | null
  activeSend: { id: string; phase: string } | null
  queuedSends: { id: string; phase: string }[]
  question: DockQuestion | null
  options: DockOptions
  notice: string | null
}

export type DockTransport = 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'offline'

export type DockHostReport = {
  mounted: boolean
  focused: boolean
  transport: DockTransport
}
/** Checks the serialized fields the terminal host forwards and acts on. */
export function isDockState(value: unknown): value is DockState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const state = value as Partial<DockState>
  const options = state.options
  const activeSend = state.activeSend
  const question = state.question
  return (
    typeof state.pane === 'string' &&
    typeof state.session === 'string' &&
    typeof state.tab === 'string' &&
    typeof state.revision === 'number' &&
    Number.isInteger(state.revision) &&
    typeof state.enabled === 'boolean' &&
    typeof state.supported === 'boolean' &&
    (typeof state.agent === 'string' || state.agent === null) &&
    typeof state.docked === 'boolean' &&
    typeof state.userUndocked === 'boolean' &&
    typeof state.gutterRows === 'number' &&
    Number.isInteger(state.gutterRows) &&
    state.gutterRows >= 3 &&
    state.gutterRows <= 15 &&
    typeof state.mounted === 'boolean' &&
    typeof state.passthrough === 'boolean' &&
    typeof state.draft === 'string' &&
    Array.isArray(state.attachments) &&
    (typeof state.disabledReason === 'string' || state.disabledReason === null) &&
    (activeSend === null || typeof activeSend === 'object' && activeSend !== null && !Array.isArray(activeSend)) &&
    Array.isArray(state.queuedSends) &&
    (question === null || typeof question === 'object' && question !== null && !Array.isArray(question)) &&
    typeof options === 'object' &&
    options !== null &&
    !Array.isArray(options) &&
    (typeof state.notice === 'string' || state.notice === null)
  )
}
