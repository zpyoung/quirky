import { QUIRKY_AGENT_SESSION_ID_ENV } from '../../../../shared/agent-session-caller-env'
import { QUIRKY_STRUCTURED_SESSION_ENV } from '../../../../shared/structured-session-marker'

export const AGENT_HOOK_RUNTIME_ENV_KEYS = [
  'QUIRKY_AGENT_HOOK_PORT',
  'QUIRKY_AGENT_HOOK_TOKEN',
  'QUIRKY_AGENT_HOOK_ENV',
  'QUIRKY_AGENT_HOOK_VERSION',
  'QUIRKY_AGENT_HOOK_TRANSPORT',
  'QUIRKY_AGENT_HOOK_ENDPOINT',
  // Why: PR 2778 briefly exported this path; keep deleting stale inherited values so older PTYs can't leak the reverted path.
  'QUIRKY_CLAUDE_AGENT_STATUS_SETTINGS'
] as const

// Why: Quirky never sets these, so an inherited value means a pty host launched from inside a Claude session — Claude reads it as a nested child and silently stops persisting the transcript.
export const CLAUDE_CHILD_SESSION_STAMP_ENV_KEYS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID'
] as const

// Why: Quirky writes these only into a structured session's own spawn, so an inherited value means a pty host launched from inside one — every pane would claim that session as its orchestration caller.
export const QUIRKY_AGENT_SESSION_CALLER_ENV_KEYS = [
  QUIRKY_AGENT_SESSION_ID_ENV,
  QUIRKY_STRUCTURED_SESSION_ENV
] as const
