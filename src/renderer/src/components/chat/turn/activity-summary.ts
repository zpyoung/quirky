import { agentJournalToolCallLifecycle } from '../../../../../shared/agent-journal-tool-call-lifecycle'
import type { RenderItemOf } from '../chat-turns'
import { formatDuration } from './elapsed'

type ToolCategory = 'read' | 'search' | 'command' | 'web' | 'other'

/** Which family a tool belongs to, from its name in any agent's spelling. */
export function toolCategoryOf(tool: string): ToolCategory {
  const name = tool.toLowerCase().replace(/[^a-z]/g, '')
  if (name.startsWith('web') || name.startsWith('fetch') || name.startsWith('browse')) {
    return 'web'
  }
  if (name.startsWith('read') || name === 'view' || name === 'cat' || name.startsWith('open')) {
    return 'read'
  }
  if (/^(grep|glob|search|find|ls|list|rg)/.test(name)) {
    return 'search'
  }
  if (/^(bash|shell|exec|command|run|terminal)/.test(name)) {
    return 'command'
  }
  return 'other'
}

const NOUNS: Record<ToolCategory, [string, string]> = {
  read: ['file', 'files'],
  search: ['pattern', 'patterns'],
  command: ['command', 'commands'],
  web: ['page', 'pages'],
  other: ['other tool', 'other tools']
}

const VERBS: Record<ToolCategory, { done: string; running: string }> = {
  read: { done: 'read', running: 'reading' },
  search: { done: 'searched', running: 'searching' },
  command: { done: 'ran', running: 'running' },
  web: { done: 'fetched', running: 'fetching' },
  other: { done: 'used', running: 'using' }
}

/** A call still running in a turn that ended never finished; it reads as interrupted. */
export function callLifecycle(
  call: RenderItemOf<'tool-call'>,
  turnEnded: boolean
): 'running' | 'completed' | 'failed' | 'interrupted' {
  const lifecycle = agentJournalToolCallLifecycle(call.body) ?? 'completed'
  return lifecycle === 'running' && turnEnded ? 'interrupted' : lifecycle
}

const plural = (count: number, [one, many]: [string, string]): string =>
  `${count} ${count === 1 ? one : many}`

/**
 * One line for a folded run of calls: "Read 4 files · searched 2 patterns · 12s". Calls still
 * running read as "running 1 command" and the run shows no time until none is running. Failed
 * and interrupted calls are counted at the end.
 */
export function summarizeActivity(
  calls: readonly RenderItemOf<'tool-call'>[],
  turnEnded = false
): string {
  const order: ToolCategory[] = []
  const tally = new Map<ToolCategory, { done: number; running: number }>()
  let failed = 0
  let interrupted = 0
  let running = 0
  let spentMs = 0
  for (const call of calls) {
    const category = toolCategoryOf(call.body.name)
    const counts = tally.get(category) ?? { done: 0, running: 0 }
    if (!tally.has(category)) {
      tally.set(category, counts)
      order.push(category)
    }
    const lifecycle = callLifecycle(call, turnEnded)
    if (lifecycle === 'running') {
      counts.running += 1
      running += 1
    } else {
      counts.done += 1
      failed += lifecycle === 'failed' ? 1 : 0
      interrupted += lifecycle === 'interrupted' ? 1 : 0
    }
    spentMs += call.body.durationMs ?? 0
  }
  const parts: string[] = []
  for (const category of order) {
    const counts = tally.get(category)
    if (counts && counts.done > 0) {
      parts.push(`${VERBS[category].done} ${plural(counts.done, NOUNS[category])}`)
    }
    if (counts && counts.running > 0) {
      parts.push(`${VERBS[category].running} ${plural(counts.running, NOUNS[category])}`)
    }
  }
  const first = parts[0] ?? 'no activity'
  const line = [`${first.charAt(0).toUpperCase()}${first.slice(1)}`, ...parts.slice(1)]
  if (failed > 0) {
    line.push(`${failed} failed`)
  }
  if (interrupted > 0) {
    line.push(`${interrupted} interrupted`)
  }
  const span = running === 0 ? formatDuration(spentMs) : ''
  if (span !== '') {
    line.push(span)
  }
  return line.join(' · ')
}
