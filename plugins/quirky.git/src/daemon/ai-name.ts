import { randomUUID } from 'node:crypto'
import type { Worktree } from '@quirky/protocol'
import { gitApi } from '@quirky/git'
import { buildBranchNamePrompt, buildConversationNamePrompt, renderTemplate } from './ai-prompts'
import {
  parseLaunchOptions,
  pickDefaultAgent,
  recipeAction,
  saveRecipe,
  type EffectiveRecipe,
  type RecipeAction
} from './ai-recipes'
import type { DaemonEnv, Handler } from './env'
import { isRecord } from './validation'

type NameAction = Extract<RecipeAction, 'branchName' | 'conversationName'>
type AgentChoice = { id: string; plugin: string; installed: boolean; enabled: boolean; canGenerate: boolean }
type CapturedMessage = { role: 'user' | 'assistant'; text: string }
type CapturedConversation = { session: string; agent: string; messages: CapturedMessage[]; firstSeq: number; lastSeq: number }

const MAX_NAME_BYTES = 4096
const MAX_BRANCH_NAME_LENGTH = 128
const MAX_CONVERSATION_TITLE_LENGTH = 120
const MAX_CONVERSATION_CONTEXT_BYTES = 32 * 1024
const MAX_CONVERSATION_MESSAGE_CHARS = 8_000

function invalid(env: DaemonEnv, reason: string, message: string): never {
  throw env.errors.reasoned('invalid-params', reason, message)
}

function conflict(env: DaemonEnv, reason: string, message: string): never {
  throw env.errors.reasoned('conflict', reason, message)
}

function suppliedText(env: DaemonEnv, params: Record<string, unknown>, key: 'template' | 'args'): string | undefined {
  if (!Object.hasOwn(params, key)) return undefined
  const value = params[key]
  if (typeof value !== 'string') return invalid(env, `invalid-${key}`, `${key} must be a string.`)
  return value
}

async function generatorChoice(
  env: DaemonEnv,
  asked: string | undefined,
  recipe: EffectiveRecipe
): Promise<{ choice: AgentChoice; source: string }> {
  let value: unknown
  try {
    value = await env.context.call('quirky.agents/list', {})
  } catch {
    return conflict(env, 'agent-catalog-unavailable', 'The agent catalog is unavailable; refresh agents and try again.')
  }
  if (!isRecord(value) || !Array.isArray(value.agents)) {
    return conflict(env, 'agent-catalog-invalid', 'The agent catalog returned invalid data.')
  }
  const usable = value.agents.flatMap((item): AgentChoice[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.plugin !== 'string' ||
      typeof item.installed !== 'boolean' || typeof item.enabled !== 'boolean') return []
    return [{ id: item.id, plugin: item.plugin, installed: item.installed, enabled: item.enabled, canGenerate: item.canGenerate === true }]
  }).filter((item) => item.installed && item.enabled && item.canGenerate)

  const wanted = asked ?? recipe.agent
  if (typeof wanted === 'string' && wanted !== '') {
    if (wanted === 'custom') return invalid(env, 'name-provider-unsupported', 'Custom commands cannot generate canonical names.')
    const choice = usable.find((item) => item.id === wanted)
    if (choice) return { choice, source: asked !== undefined ? 'request' : recipe.sources.agent }
    if (asked !== undefined) return invalid(env, 'agent-unavailable', `${wanted} is not installed, enabled, or supported for one-shot generation.`)
    return conflict(env, 'agent-unavailable', 'The saved AI agent cannot generate one-shot names. Customize the recipe to choose a supported provider.')
  }

  let preferred: string | undefined
  try {
    const picked = await pickDefaultAgent(env)
    preferred = picked
  } catch {
    preferred = undefined
  }
  const choice = usable.find((item) => item.id === preferred) ?? usable[0]
  if (!choice) return conflict(env, 'no-agents', 'No enabled one-shot agents. Configure a supported agent in Settings.')
  return { choice, source: choice.id === preferred ? 'default-agent' : 'first-one-shot-agent' }
}

async function capturedConversation(
  env: DaemonEnv,
  worktree: Worktree,
  value: unknown
): Promise<CapturedConversation> {
  if (typeof value !== 'string' || value.trim() === '' || value.trim() !== value) {
    return invalid(env, 'session-required', 'An exact structured session ID is required to name a conversation.')
  }
  let session: unknown
  try {
    session = await env.context.call('quirky.session/get', { session: value })
  } catch {
    return conflict(env, 'session-unavailable', 'The selected conversation is unavailable.')
  }
  if (!isRecord(session) || session.id !== value || session.kind !== 'structured' || session.worktreeId !== worktree.id ||
    typeof session.agent !== 'string') {
    return conflict(env, 'session-mismatch', 'The selected conversation is not a structured session in this worktree.')
  }

  let rawMessages: unknown
  try {
    rawMessages = await env.context.call('quirky.structured/messages', { session: value, tail: true, limit: 1000 })
  } catch {
    return conflict(env, 'conversation-unavailable', 'The selected conversation history is unavailable.')
  }
  if (!Array.isArray(rawMessages)) return conflict(env, 'conversation-invalid', 'The selected conversation history is invalid.')
  const messages: { seq: number; role: 'user' | 'assistant'; text: string }[] = []
  for (const item of rawMessages) {
    if (!isRecord(item) || item.sessionId !== value || !Number.isSafeInteger(item.seq) || typeof item.text !== 'string') {
      return conflict(env, 'conversation-invalid', 'The selected conversation history is invalid.')
    }
    if (item.role !== 'user' && item.role !== 'assistant') continue
    messages.push({ seq: item.seq as number, role: item.role, text: item.text })
  }
  messages.sort((left, right) => left.seq - right.seq)
  const captured: { seq: number; role: 'user' | 'assistant'; text: string }[] = []
  let bytes = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    const text = message.text.length > MAX_CONVERSATION_MESSAGE_CHARS
      ? `${message.text.slice(0, MAX_CONVERSATION_MESSAGE_CHARS)}\n[message truncated]`
      : message.text
    const size = Buffer.byteLength(text, 'utf8')
    if (bytes + size > MAX_CONVERSATION_CONTEXT_BYTES) break
    captured.unshift({ seq: message.seq, role: message.role, text })
    bytes += size
  }
  if (captured.length === 0) return conflict(env, 'conversation-empty', 'The selected conversation has no readable user or assistant messages.')

  let current: unknown
  try {
    current = await env.context.call('quirky.session/get', { session: value })
  } catch {
    return conflict(env, 'session-changed', 'The selected conversation changed while its history was being read.')
  }
  if (!isRecord(current) || current.id !== session.id || current.kind !== 'structured' ||
    current.worktreeId !== session.worktreeId || current.agent !== session.agent) {
    return conflict(env, 'session-changed', 'The selected conversation changed while its history was being read.')
  }
  return {
    session: value,
    agent: session.agent,
    messages: captured.map(({ role, text }) => ({ role, text })),
    firstSeq: captured[0]!.seq,
    lastSeq: captured.at(-1)!.seq
  }
}

async function singleName(env: DaemonEnv, action: NameAction, output: string): Promise<string> {
  const candidate = output.trim()
  if (candidate === '' || Buffer.byteLength(candidate, 'utf8') > MAX_NAME_BYTES || /[\u0000-\u001f\u007f]/.test(candidate) ||
    candidate.includes('\n') || candidate.startsWith('```') || /^(name|title)\s*:/i.test(candidate)) {
    return invalid(env, 'invalid-name', 'The provider did not return one bounded name candidate.')
  }
  if (action === 'branchName') {
    if (candidate.length > MAX_BRANCH_NAME_LENGTH) return invalid(env, 'invalid-name', 'The generated branch name is too long.')
    let valid: boolean
    try {
      valid = await gitApi().checkRefFormatBranch(candidate)
    } catch {
      return conflict(env, 'branch-validation-unavailable', 'The generated branch name could not be validated; no branch was changed.')
    }
    if (!valid) return invalid(env, 'invalid-name', 'The generated name is not a valid Git branch name; no branch was changed.')
    return candidate
  }
  if (candidate.length > MAX_CONVERSATION_TITLE_LENGTH) return invalid(env, 'invalid-name', 'The generated conversation title is too long.')
  return candidate
}

/** Generates a bounded branch-name or conversation-name candidate; it never renames either owner. */
export function aiName(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const action = recipeAction(env, params.action, ['branchName', 'conversationName']) as NameAction
    const saveScope = params.save
    if (saveScope !== undefined && saveScope !== 'repo' && saveScope !== 'global') {
      return invalid(env, 'invalid-save-scope', 'save must be repo or global.')
    }
    const worktree = await env.resolve(params, caller)
    const saved = env.recipes.effective(action, worktree.repoId)
    const askedAgent = params.agent === undefined || params.agent === null || params.agent === ''
      ? undefined
      : typeof params.agent === 'string' ? params.agent : invalid(env, 'invalid-agent', 'agent must be a string.')
    if (askedAgent !== undefined && (askedAgent.trim() === '' || askedAgent.trim() !== askedAgent)) {
      return invalid(env, 'invalid-agent', 'agent must be a non-empty trimmed string.')
    }
    const selected = await generatorChoice(env, askedAgent, saved)
    const recipe = env.recipes.effective(action, worktree.repoId, selected.choice.id)
    const args = suppliedText(env, params, 'args') ?? recipe.args
    const template = suppliedText(env, params, 'template') ?? recipe.template
    const rawLaunchOptions = Object.hasOwn(params, 'launchOptions') ? params.launchOptions : recipe.launchOptions
    const launchOptions = parseLaunchOptions(env, rawLaunchOptions)

    let basePrompt: string
    let contextSource: Record<string, unknown>
    if (action === 'branchName') {
      const initial = await env.readStatus(worktree)
      if (typeof initial.branch !== 'string' || initial.branch === '' || typeof initial.head !== 'string' || initial.head === '') {
        return conflict(env, 'branch-unavailable', 'A checked-out branch and current head are required to name this branch.')
      }
      const compare = await readCompare(env, worktree)
      if (compare.status !== 'ready') return conflict(env, 'branch-comparison-unavailable', compare.message ?? 'The current branch could not be compared with its base.')
      const workPrompt = params.session === undefined ? undefined : await capturedConversation(env, worktree, params.session)
      const current = await env.readStatus(worktree)
      if (current.branch !== initial.branch || current.head !== initial.head || compare.headOid !== current.head) {
        return conflict(env, 'stale-branch', 'The branch changed while its naming context was being read. Refresh and try again.')
      }
      basePrompt = buildBranchNamePrompt({
        worktreePath: worktree.path,
        branch: initial.branch,
        compare,
        changes: initial.entries,
        ...(workPrompt === undefined ? {} : { workPrompt: workPrompt.messages.map((message) => `${message.role}: ${message.text}`).join('\n') })
      })
      contextSource = {
        kind: 'branch',
        branch: initial.branch,
        head: initial.head,
        base: compare.base,
        ...(workPrompt === undefined ? {} : { session: workPrompt.session, firstSeq: workPrompt.firstSeq, lastSeq: workPrompt.lastSeq })
      }
    } else {
      const captured = await capturedConversation(env, worktree, params.session)
      basePrompt = buildConversationNamePrompt({
        worktreePath: worktree.path,
        session: captured.session,
        agent: captured.agent,
        messages: captured.messages
      })
      contextSource = {
        kind: 'conversation',
        session: captured.session,
        provider: captured.agent,
        firstSeq: captured.firstSeq,
        lastSeq: captured.lastSeq
      }
    }

    const prompt = renderTemplate(template, { basePrompt })
    if (prompt.trim() === '') return invalid(env, 'empty-name-prompt', 'The name-generation prompt is empty; update the naming recipe.')
    const generated = await env.context.call('quirky.agents/generate', {
      agent: selected.choice.id,
      prompt,
      requestId: randomUUID(),
      worktree: worktree.id,
      ...(args.trim() === '' ? {} : { args }),
      ...(launchOptions?.model === undefined ? {} : { model: launchOptions.model }),
      ...(launchOptions?.optionValues === undefined ? {} : { optionValues: launchOptions.optionValues })
    })
    if (!isRecord(generated) || typeof generated.text !== 'string' || generated.agent !== selected.choice.id) {
      return conflict(env, 'name-generation-invalid', 'The one-shot provider returned an invalid name response.')
    }
    const name = await singleName(env, action, generated.text)
    const savedRecipe = saveScope === undefined
      ? false
      : saveRecipe(env, worktree, action, saveScope, { agent: selected.choice.id, args, template, launchOptions }, selected.choice.id)
    const effective = env.recipes.effective(action, worktree.repoId, selected.choice.id)
    return {
      action,
      name,
      agent: selected.choice.id,
      host: 'local',
      context: contextSource,
      recipe: effective,
      providerSource: {
        host: 'local',
        plugin: selected.choice.plugin,
        agent: selected.source,
        args: params.args === undefined ? recipe.sources.args : 'request',
        template: params.template === undefined ? recipe.sources.template : 'request',
        launchOptions: params.launchOptions === undefined ? recipe.sources.launchOptions : 'request'
      },
      saved: savedRecipe
    }
  }
}
