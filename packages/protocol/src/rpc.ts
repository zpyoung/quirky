import type {
  AgentKind,
  Ask,
  AskAnswer,
  AskEnvelope,
  AskSpec,
  GitDiff,
  GitStatus,
  Repo,
  Session,
  Settings,
  StructuredMessage,
  Worktree
} from './model'
import type { ContributionInfo, PluginInfo } from './plugins'

/** Bumped on any breaking change to `Methods`, `QuirkyEvent` or the frame layout. */
export const PROTOCOL_VERSION = 1

export type ClientRole = 'desktop' | 'ui' | 'cli' | 'mobile'

type Ok = { ok: true }

/**
 * Every daemon method: params in, result out. The desktop UI, the CLI and mobile all use these;
 * there is no separate IPC surface.
 */
export type Methods = {
  'client.hello': {
    params: { role: ClientRole; name?: string; protocolVersion: number }
    result: { protocolVersion: number; daemonVersion: string }
  }
  'events.subscribe': { params: Record<string, never>; result: Ok }

  'status.get': {
    params: Record<string, never>
    result: {
      daemonVersion: string
      pid: number
      startedAt: number
      home: string
      ptyHost: { pid: number | null; alive: boolean }
      clients: { role: ClientRole; name?: string }[]
    }
  }

  'settings.get': { params: Record<string, never>; result: Settings }
  'settings.set': { params: Partial<Settings>; result: Settings }

  'repo.list': { params: Record<string, never>; result: Repo[] }
  /** Resolves `path` to its repository toplevel; adding the same repo twice returns the existing one. */
  'repo.add': { params: { path: string }; result: Repo }
  'repo.remove': { params: { repoId: string }; result: Ok }

  'worktree.list': { params: { repoId?: string }; result: Worktree[] }
  /** Creates branch `name` from `baseRef` (default: the repo's current HEAD) at `<worktreesRoot>/<repo>/<name>`. */
  'worktree.create': {
    params: { repoId: string; name: string; baseRef?: string }
    result: Worktree
  }
  'worktree.remove': { params: { worktreeId: string; force?: boolean }; result: Ok }

  'session.list': { params: { worktreeId?: string }; result: Session[] }
  /** Starts a terminal session; `prompt` is passed to agents that accept an initial prompt. */
  'session.create': {
    params: { worktreeId: string; agent: AgentKind; prompt?: string; cols?: number; rows?: number }
    result: Session
  }
  /** Starts a structured (no PTY) background agent session; only `claude` is supported in v1. */
  'session.createStructured': {
    params: { worktreeId: string; agent: AgentKind; prompt: string }
    result: Session
  }
  /** Kills the process if alive and forgets the session. */
  'session.close': { params: { sessionId: string }; result: Ok }

  /**
   * Starts streaming a terminal session to this client. `replay` is base64 of recent output (up to
   * 1 MiB, starting on a line boundary) to write into a fresh terminal; live output follows as
   * binary frames tagged with `streamId`, starting exactly at byte `offset`.
   */
  'terminal.attach': {
    params: { sessionId: string; cols: number; rows: number }
    result: { streamId: number; replay: string; offset: number }
  }
  'terminal.detach': { params: { streamId: number }; result: Ok }
  /** Raw input, as typed. */
  'terminal.write': { params: { sessionId: string; data: string }; result: Ok }
  'terminal.resize': { params: { sessionId: string; cols: number; rows: number }; result: Ok }
  /** Sends a prompt as a bracketed paste, then Enter as a separate write when `enter` is set. */
  'terminal.send': { params: { sessionId: string; text: string; enter?: boolean }; result: Ok }
  /** The visible screen plus up to `lines` (default 50) of recent scrollback, as plain text. */
  'terminal.read': {
    params: { sessionId: string; lines?: number }
    result: { lines: string[]; cols: number; rows: number; alt: boolean }
  }

  'git.status': { params: { worktreeId: string }; result: GitStatus }
  'git.diff': { params: { worktreeId: string; path: string; staged: boolean }; result: GitDiff }
  'git.stage': { params: { worktreeId: string; paths: string[] }; result: Ok }
  'git.unstage': { params: { worktreeId: string; paths: string[] }; result: Ok }
  'git.commit': { params: { worktreeId: string; message: string }; result: { sha: string } }

  'ask.create': {
    params: { spec: AskSpec; sessionId?: string; worktreeId?: string }
    result: { askId: string }
  }
  /** Long-polls up to `timeoutMs` (max 60000); returns status `pending` if still unanswered. */
  'ask.wait': { params: { askId: string; timeoutMs?: number }; result: AskEnvelope }
  'ask.answer': {
    params: { askId: string; answers: Record<string, AskAnswer>; skipped?: string[] }
    result: AskEnvelope
  }
  'ask.cancel': { params: { askId: string }; result: AskEnvelope }
  'ask.list': { params: { pendingOnly?: boolean }; result: Ask[] }

  'structured.messages': {
    params: { sessionId: string; afterSeq?: number }
    result: StructuredMessage[]
  }
  'structured.send': { params: { sessionId: string; text: string }; result: Ok }

  /** Every discovered plugin, including invalid ones, with its state and diagnostics. */
  'plugin.list': { params: Record<string, never>; result: PluginInfo[] }
  /** Only `effective` contributions unless `all` is set, which returns every declaration. */
  'plugin.contributions': {
    params: { kind?: string; pluginId?: string; all?: boolean }
    result: ContributionInfo[]
  }
  /** Clears the user's disable of plugin `id`. */
  'plugin.enable': { params: { id: string }; result: Ok }
  /** Disables plugin `id` and every plugin that depends on it. */
  'plugin.disable': { params: { id: string }; result: Ok }
  /** Activates the plugin now instead of waiting for first use. */
  'plugin.activate': { params: { pluginId: string }; result: PluginInfo }
}

export type MethodName = keyof Methods
export type ParamsOf<M extends MethodName> = Methods[M]['params']
export type ResultOf<M extends MethodName> = Methods[M]['result']

/** Pushed to clients that called `events.subscribe`, as JSON-RPC notifications named `event`. */
export type QuirkyEvent =
  | { type: 'repo.changed' }
  | { type: 'worktree.changed'; repoId: string }
  | { type: 'session.changed'; session: Session }
  | { type: 'session.removed'; sessionId: string }
  | { type: 'git.changed'; worktreeId: string }
  | { type: 'ask.created'; ask: Ask }
  | { type: 'ask.resolved'; askId: string; envelope: AskEnvelope }
  | { type: 'notify'; title: string; body: string; sessionId?: string; worktreeId?: string }
  | { type: 'structured.message'; message: StructuredMessage }
  | { type: 'plugin.changed' }

export type RpcRequest = { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
export type RpcSuccess = { jsonrpc: '2.0'; id: number; result: unknown }
export type RpcFailure = {
  jsonrpc: '2.0'
  id: number | null
  error: { code: number; message: string; data?: unknown }
}
export type RpcNotification = { jsonrpc: '2.0'; method: 'event'; params: QuirkyEvent }

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  Unauthorized: -32001,
  NotFound: -32004,
  Conflict: -32009
} as const

/** WebSocket path on the daemon's loopback port; auth is `?token=<runtime token>`. */
export const RPC_PATH = '/rpc'
/** Agent hooks POST here: `/hook/<agent>?session=<id>` with header `x-quirky-hook-token`. */
export const HOOK_PATH_PREFIX = '/hook/'
export const HOOK_TOKEN_HEADER = 'x-quirky-hook-token'
