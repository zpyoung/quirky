/** The `/` commands Quirky handles itself; picking one acts at once instead of being sent to the agent. */
export type QuirkyCommandName = 'model' | 'effort' | 'mode' | 'plan' | 'new' | 'stop' | 'resume'

export type QuirkyCommand = { name: QuirkyCommandName; description: string }

export const QUIRKY_COMMANDS: readonly QuirkyCommand[] = [
  { name: 'model', description: 'Switch model' },
  { name: 'effort', description: 'Set effort' },
  { name: 'mode', description: 'Choose permission mode' },
  { name: 'plan', description: 'Toggle plan mode' },
  { name: 'new', description: 'New chat, same agent and settings' },
  { name: 'stop', description: 'Stop the running turn' },
  { name: 'resume', description: 'Resume an ended session' }
]
