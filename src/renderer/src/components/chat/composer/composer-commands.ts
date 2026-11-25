import type { AgentSessionConversationCommand } from '../../../../../shared/agent-session-conversation-command'
import type { AgentSessionSlashCommand } from '../../../../../shared/agent-session-wire'

/**
 * One entry of the `/` list. A `host` command (compact, clear) is run by the surrounding view through
 * `onRunCommand`; a `command` or `skill` is the agent's own and goes into the message as a pill.
 */
export type ComposerCommand = {
  name: string
  kind: 'host' | 'command' | 'skill'
  description?: string
  argumentHint?: string
}

const HOST_COMMAND_DESCRIPTIONS: Record<AgentSessionConversationCommand, string> = {
  clear: 'Start over with an empty context',
  compact: 'Summarize the conversation to free up context'
}

/** Builds the `/` list from what the session controller reports; host commands come first. */
export function composerCommandsFor(source: {
  conversationCommands?: readonly AgentSessionConversationCommand[]
  sessionCommands?: readonly AgentSessionSlashCommand[]
}): ComposerCommand[] {
  const host = (source.conversationCommands ?? []).map((name): ComposerCommand => ({
    name,
    kind: 'host',
    description: HOST_COMMAND_DESCRIPTIONS[name]
  }))
  const hostNames = new Set(host.map((command) => command.name))
  const agent = (source.sessionCommands ?? [])
    .filter((command) => !hostNames.has(command.name))
    .map((command): ComposerCommand => ({
      name: command.name,
      kind: command.kind,
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint })
    }))
  return [...host, ...agent]
}

/** The `/` commands the composer handles itself; picking one acts at once instead of being sent. */
export type LocalCommandName = 'model' | 'effort' | 'mode' | 'plan' | 'stop'

export type LocalCommand = { name: LocalCommandName; description: string }

export const LOCAL_COMMANDS: readonly LocalCommand[] = [
  { name: 'model', description: 'Switch model' },
  { name: 'effort', description: 'Set effort' },
  { name: 'mode', description: 'Choose permission mode' },
  { name: 'plan', description: 'Switch to or from plan mode' },
  { name: 'stop', description: 'Stop the running turn' }
]
