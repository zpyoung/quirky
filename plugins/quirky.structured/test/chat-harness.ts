import { mkdtempSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { QuirkyClient, QuirkyEvent, RpcError, Session, StructuredMessage } from '@quirky/protocol'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import type { StructuredContext, StructuredRunner, StructuredSendOptions, StructuredSettings, StructuredStartOptions } from '../runner'
import { FakeWorld } from './fakes/world'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const FAKES_DIR = join(PLUGIN_DIR, 'test', 'fakes')
const globals = globalThis as any

/** What the fake `quirky.git` answers; each handler may throw to simulate a failing call. */
export type FakeGit = {
  calls: { method: 'snapshotTree' | 'treeChanges'; params: Record<string, unknown> }[]
  snapshotTree: (params: Record<string, unknown>, context: any) => unknown
  treeChanges: (params: Record<string, unknown>, context: any) => unknown
}

/** A runner the tests drive by hand: it records sends and lets a test end a turn. */
export class ChatRunner implements StructuredRunner {
  sent: { sessionId: string; text: string; options?: StructuredSendOptions }[] = []
  sendError: Error | null = null
  constructor(readonly context: StructuredContext) {}
  async start(session: Session, prompt?: string, _options?: StructuredStartOptions) {
    if (prompt !== undefined && prompt !== '') {
      this.context.appendMessage({ sessionId: session.id, role: 'user', text: prompt })
      this.context.setStatus(session.id, 'working')
    } else this.context.setStatus(session.id, 'running')
  }
  async send(sessionId: string, text: string, options?: StructuredSendOptions) {
    if (this.sendError) throw this.sendError
    this.onSend?.()
    this.sent.push({ sessionId, text, ...(options === undefined ? {} : { options }) })
    this.context.appendMessage({ sessionId, role: 'user', text, item: { kind: 'user', text, ...(options?.queuedId ? { queuedId: options.queuedId } : {}) } })
    this.context.setStatus(sessionId, 'working')
  }
  configured: { sessionId: string; settings: StructuredSettings }[] = []
  async configure(sessionId: string, settings: StructuredSettings) {
    this.configured.push({ sessionId, settings })
    return settings
  }
  /** Runs when a message reaches the agent, before it is recorded; lets a test observe ordering. */
  onSend: (() => void) | null = null
  interrupted: string[] = []
  async interrupt(sessionId: string) {
    this.interrupted.push(sessionId)
    this.context.setStatus(sessionId, 'done')
  }
  async stop(_sessionId: string) {}
  finish(sessionId: string) {
    this.context.setStatus(sessionId, 'done')
  }
}

export type ChatBoot = {
  h: Harness
  client: QuirkyClient
  events: QuirkyEvent[]
  world: FakeWorld
  runner: ChatRunner
  git: FakeGit
  call(method: string, params?: Record<string, unknown>): Promise<any>
  create(prompt?: string): Promise<Session>
  messages(session: string): Promise<StructuredMessage[]>
  emitView(event: 'changed' | 'rejected', data: unknown): void
  failure(promise: Promise<unknown>): Promise<RpcError>
  stopDaemon(): Promise<void>
}

const shortHome = () => mkdtempSync('/tmp/qs-')

/** Boots the daemon with the structured plugin, the session/ask/agents fakes and, optionally, fake `quirky.git` and `quirky.view`. */
export async function bootChat(options: { git?: boolean; view?: boolean; home?: string; world?: FakeWorld } = {}): Promise<ChatBoot> {
  const world = options.world ?? new FakeWorld()
  const git: FakeGit = {
    calls: [],
    snapshotTree: () => ({ tree: 'tree-0' }),
    treeChanges: () => ({ changes: [] })
  }
  const boot = {} as ChatBoot
  globals.__structuredFakes = world
  globals.__chatFakes = {
    git: {
      snapshotTree: (params: Record<string, unknown>, context: any) => {
        git.calls.push({ method: 'snapshotTree', params })
        return git.snapshotTree(params, context)
      },
      treeChanges: (params: Record<string, unknown>, context: any) => {
        git.calls.push({ method: 'treeChanges', params })
        return git.treeChanges(params, context)
      }
    },
    emitView: () => {}
  }
  let runner: ChatRunner | undefined
  globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = (context: StructuredContext) => (runner = new ChatRunner(context))
  const dir = makeTempDir('qs-builtin-')
  symlinkSync(PLUGIN_DIR, join(dir, 'quirky.structured'))
  const ids = ['quirky.session', 'quirky.worktree', 'quirky.ask', 'quirky.agents']
  if (options.git) ids.push('quirky.git')
  if (options.view) ids.push('quirky.view')
  for (const id of ids) symlinkSync(join(FAKES_DIR, id), join(dir, id))
  const h = await startHarness({ home: options.home ?? shortHome(), builtinPluginsDir: dir })
  const { client, events } = await h.connectWithEvents('cli')
  const call = (method: string, params: Record<string, unknown> = {}) => client.callAny(method, params) as Promise<any>
  Object.assign(boot, {
    h,
    client,
    events,
    world,
    git,
    call,
    create: (prompt = 'go') => call('quirky.structured/create', { worktree: 'main', agent: 'claude', prompt }) as Promise<Session>,
    messages: (session: string) => call('quirky.structured/messages', { session }) as Promise<StructuredMessage[]>,
    emitView: (event: 'changed' | 'rejected', data: unknown) => globals.__chatFakes.emitView(event, data),
    failure: async (promise: Promise<unknown>) => {
      try {
        await promise
      } catch (error) {
        return error as RpcError
      }
      throw new Error('expected the call to reject')
    },
    stopDaemon: async () => {
      for (const c of h.clients) c.close()
      await h.daemon.stop()
      h.pty.stop()
    }
  })
  Object.defineProperty(boot, 'runner', { get: () => runner })
  return boot
}

/** Tears down the harness and the globals the fakes read. */
export async function teardownChat(boot: ChatBoot | undefined): Promise<void> {
  await boot?.h.cleanup()
  removeTempDirs()
  delete globals.__structuredFakes
  delete globals.__chatFakes
  delete globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
}
