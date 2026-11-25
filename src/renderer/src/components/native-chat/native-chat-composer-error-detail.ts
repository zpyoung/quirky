import type { StructuredAgentSessionCommandRefusalCause } from '../../../../shared/structured-agent-session-composer'

export type NativeChatComposerErrorDetail = {
  /** Error text Quirky did not write, shown apart and copyable. */
  errorText?: string
  /** A refused command's cause: its line is said only while that still holds. */
  refusedWhile?: StructuredAgentSessionCommandRefusalCause
}
