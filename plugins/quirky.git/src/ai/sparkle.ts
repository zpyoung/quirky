export type SparkleKind = 'generating' | 'committing' | 'nothing-staged' | 'has-message' | 'no-agent' | 'ready'

export type SparkleInput = {
  staged: number
  message: string
  generating: boolean
  committing: boolean
  /** False only when the agents were read and none can write a message. */
  agentAvailable: boolean
}

export type SparkleState = { kind: SparkleKind; title: string; disabled: boolean }

/** What the commit box's sparkle shows and whether it can be pressed, by Orca's order of reasons. */
export function sparkleState({ staged, message, generating, committing, agentAvailable }: SparkleInput): SparkleState {
  if (generating) return { kind: 'generating', title: 'Generating commit message…', disabled: true }
  if (committing) return { kind: 'committing', title: 'Commit in progress…', disabled: true }
  if (staged === 0) return { kind: 'nothing-staged', title: 'Stage at least one file to generate a message.', disabled: true }
  if (message.trim() !== '') return { kind: 'has-message', title: 'Clear the message to regenerate.', disabled: true }
  if (!agentAvailable) return { kind: 'no-agent', title: 'Pick an agent in Source Control AI settings.', disabled: false }
  return { kind: 'ready', title: 'ai commit msg', disabled: false }
}
