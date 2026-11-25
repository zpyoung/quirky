import { translate } from '@/i18n/i18n'
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

function hostCommandDescription(name: AgentSessionConversationCommand): string {
  return name === 'clear'
    ? translate('components.chat.composer.commandClear', 'Start over with an empty context')
    : translate(
        'components.chat.composer.commandCompact',
        'Summarize the conversation to free up context'
      )
}

/** Builds the `/` list from what the session controller reports; host commands come first. */
export function composerCommandsFor(source: {
  conversationCommands?: readonly AgentSessionConversationCommand[]
  sessionCommands?: readonly AgentSessionSlashCommand[]
}): ComposerCommand[] {
  const host = (source.conversationCommands ?? []).map((name): ComposerCommand => ({
    name,
    kind: 'host',
    description: hostCommandDescription(name)
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

export function localCommands(): readonly LocalCommand[] {
  return [
    {
      name: 'model',
      description: translate('components.chat.composer.commandModel', 'Switch model')
    },
    {
      name: 'effort',
      description: translate('components.chat.composer.commandEffort', 'Set effort')
    },
    {
      name: 'mode',
      description: translate('components.chat.composer.commandMode', 'Choose permission mode')
    },
    {
      name: 'plan',
      description: translate('components.chat.composer.commandPlan', 'Switch to or from plan mode')
    },
    {
      name: 'stop',
      description: translate('components.chat.composer.commandStop', 'Stop the running turn')
    }
  ]
}
