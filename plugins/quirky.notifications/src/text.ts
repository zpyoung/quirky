export type Banner = { title: string; body: string }

export type StatusInput = {
  state: string
  outcome: string | null
  interrupted: boolean
}

export type AgentBannerInput = StatusInput & {
  repo: string | null
  worktree: string
  agentLabel: string
  lastAssistantMessage: string | null
  toolName: string | null
  toolInput: string | null
}

const CONTEXT_MAX = 80
const LABEL_MAX = 40
const BODY_MAX = 180

/**
 * Collapses whitespace runs to single spaces, trims, and shortens to at most `n` UTF-16 code
 * units. A cut ends in `…` (counted in `n`) and never leaves half of a surrogate pair.
 */
export function cut(text: string, n: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= n) return flat
  let head = flat.slice(0, Math.max(0, n - 1))
  const last = head.charCodeAt(head.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1)
  return `${head}…`
}

/** The status word an agent banner shows for a settled or waiting agent. */
export function statusWord({ state, outcome, interrupted }: StatusInput): string {
  if (state === 'waiting' || state === 'blocked') return 'needs input'
  if (interrupted) return 'stopped'
  if (state === 'done') {
    if (outcome === 'failure') return 'failed'
    if (outcome === 'cancellation') return 'stopped'
  }
  return 'finished'
}

/** Title names the place, the agent and its status; body is the first usable line of detail. */
export function agentBanner(input: AgentBannerInput): Banner {
  const worktree = input.repo ? `${input.repo} / ${input.worktree}` : input.worktree
  const context = cut(worktree, CONTEXT_MAX)
  const label = cut(input.agentLabel, LABEL_MAX)
  const status = statusWord(input)
  const message = cut(input.lastAssistantMessage ?? '', BODY_MAX)
  const tool = cut(input.toolName ?? '', BODY_MAX)
  const toolInput = cut(input.toolInput ?? '', BODY_MAX)

  let body: string
  if (message) body = message
  else if (tool && toolInput) body = cut(`Using ${tool}: ${toolInput}`, BODY_MAX)
  else if (tool) body = cut(`Using ${tool}`, BODY_MAX)
  else if (toolInput) body = cut(`Tool input: ${toolInput}`, BODY_MAX)
  else body = cut(`${label} ${status}.`, BODY_MAX)

  return { title: `${context} - ${label} ${status}`, body }
}

export function bellBanner({ repo, worktree }: { repo: string | null; worktree: string }): Banner {
  return {
    title: `Bell in ${worktree || 'workspace'}`,
    body: repo ? `${repo} · Attention requested` : 'Attention requested',
  }
}

/** Banner for an OSC or `send` notification; `body` is already cleaned by the caller. */
export function programBanner({
  worktree,
  title,
  body,
}: {
  worktree: string | null
  title: string | null
  body: string
}): Banner {
  if (!worktree) return { title: title ? `Quirky: ${title}` : 'Notification', body }
  return { title: title ? `${worktree}: ${title}` : `Notification in ${worktree}`, body }
}

export function testBanner(): Banner {
  return { title: 'Quirky notifications are on', body: 'This is a test notification from Quirky.' }
}

export function askBanner({
  title,
  firstQuestion,
}: {
  title: string | null
  firstQuestion: string
}): Banner {
  return { title: title ?? 'Question', body: firstQuestion }
}

/** Display name for an agent the registry cannot name: its id, capitalised. */
export function agentLabelFallback(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}
