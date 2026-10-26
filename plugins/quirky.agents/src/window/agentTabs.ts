import type { Session, UiPluginContext } from '@quirky/protocol'
import type { AgentInfo } from '../core/types'
import { messageOf } from './model'

export const SESSION_VIEW_ID = 'view:quirky.session/worktree'

/** The built-in agents that get a "New <Label> tab" command, in catalog order; the manifest declares the same IDs. */
export const BUILT_IN_AGENT_IDS: readonly string[] = [
  'claude',
  'claude-agent-teams',
  'openclaude',
  'codex',
  'grok',
  'copilot',
  'opencode2',
  'opencode',
  'mimo-code',
  'ante',
  'trae',
  'muse',
  'dsh',
  'qoder',
  'qoder-cn',
  'zcode',
  'pi',
  'omp',
  'prime-agent',
  'gemini',
  'antigravity',
  'aider',
  'goose',
  'amp',
  'kilo',
  'kiro',
  'crush',
  'aug',
  'autohand',
  'cline',
  'codebuff',
  'freebuff',
  'command-code',
  'continue',
  'cursor',
  'droid',
  'kimi',
  'mistral-vibe',
  'qwen-code',
  'rovo',
  'hermes',
  'devin',
  'openclaw',
  'codebuddy',
  'jcode'
]

/** The worktree the layout's open session view names, if any. */
export function layoutWorktree(context: UiPluginContext): string | null {
  const view = context.getLayout().view
  const worktree = view?.id === SESSION_VIEW_ID ? (view.input as { worktree?: unknown } | undefined)?.worktree : undefined
  return typeof worktree === 'string' && worktree !== '' ? worktree : null
}

/**
 * Starts a session of `agent` in the worktree of the open session view and opens it; with no
 * `agent`, of the one `quirky.agents/pick` chooses, which is never a plain shell. A disabled
 * agent or any failure is shown as a toast and opens nothing.
 */
export async function openAgentTab(context: UiPluginContext, agent: string | null): Promise<void> {
  const fail = (body: string) => context.toast('Could not open agent tab', body)
  const worktree = layoutWorktree(context)
  if (worktree === null) return fail('Open a worktree first')
  try {
    let chosen: string
    if (agent === null) {
      chosen = ((await context.call('quirky.agents/pick', { forAgentTab: true })) as { agent: string }).agent
    } else {
      const info = (await context.call('quirky.agents/get', { agent })) as AgentInfo
      if (!info.enabled) return fail(`${info.label} is disabled`)
      chosen = info.id
    }
    const session = (await context.call('quirky.session/create', { worktree, agent: chosen })) as Session
    context.openView(SESSION_VIEW_ID, { worktree, session: session.id })
  } catch (error) {
    fail(messageOf(error))
  }
}
