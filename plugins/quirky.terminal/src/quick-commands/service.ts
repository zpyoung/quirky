import type { MethodHandler, PluginCaller, PluginContext, Session } from '@quirky/protocol'
import type { InputTracker } from '../input-tracker'
import type { LayoutService } from '../layout/service'
import type { LayoutStore } from '../layout/store'
import type { QuickCommand } from '../layout/types'
import {
  flattenQuickCommand,
  isQuickCommandComplete,
  normalizeQuickCommands,
  quickCommandCountError,
  validateQuickCommand,
  visibleQuickCommands
} from './normalize'

type Params = Record<string, unknown>

const FIELDS = ['label', 'kind', 'agent', 'command', 'appendEnter', 'scope', 'repo'] as const

/**
 * The saved quick commands: CRUD with the limits and normalization of `normalize.ts`, scoping by
 * repo, and running a command in a pane, a new tab or a new agent tab. Changes are serialized so a
 * validation that awaits another plugin can't interleave with a second change.
 */
export class QuickCommandService {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly context: PluginContext,
    private readonly store: LayoutStore,
    private readonly layout: LayoutService,
    private readonly inputs: InputTracker
  ) {}

  readonly methods: Record<string, MethodHandler> = {
    quickCommands: (params, caller) => this.list(params, caller),
    addQuickCommand: (params, caller) => this.serial(() => this.add(params, caller)),
    updateQuickCommand: (params, caller) => this.serial(() => this.update(params, caller)),
    removeQuickCommand: (params) => this.serial(() => this.remove(params)),
    runQuickCommand: (params, caller) => this.run(params, caller)
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work)
    this.tail = run.catch(() => {})
    return run
  }

  private async list(params: Params, caller: PluginCaller): Promise<{ commands: QuickCommand[] }> {
    const all = this.store.quickCommands()
    if (params.all === true) return { commands: all }
    const workspace = await this.layout.resolveWorkspace(params.workspace, caller)
    return { commands: visibleQuickCommands(all, await this.layout.repoIdOf(workspace)) }
  }

  private async add(params: Params, caller: PluginCaller): Promise<{ commands: QuickCommand[] }> {
    const list = this.store.quickCommands()
    const full = quickCommandCountError(list.length)
    if (full) throw this.context.error('invalid-params', full)
    const draft = await this.checked(this.picked(params), caller)
    return this.save(normalizeQuickCommands([...list, draft]))
  }

  private async update(params: Params, caller: PluginCaller): Promise<{ commands: QuickCommand[] }> {
    const id = params.id as string
    const list = this.store.quickCommands()
    const index = list.findIndex((command) => command.id === id)
    if (index < 0) throw this.context.error('not-found', `no quick command ${id}`)
    const given = this.picked(params)
    const merged: Params = { ...list[index], ...given }
    if (given.kind === 'terminal' && given.agent === undefined) merged.agent = null
    if (given.kind === 'agent' && given.appendEnter === undefined) merged.appendEnter = false
    if (given.kind === 'terminal' && given.appendEnter === undefined && list[index]!.kind === 'agent') merged.appendEnter = true
    if (given.scope === 'global' && given.repo === undefined) merged.repo = null
    const draft = await this.checked(merged, caller)
    return this.save(normalizeQuickCommands(list.map((command, at) => (at === index ? draft : command))))
  }

  private async remove(params: Params): Promise<{ commands: QuickCommand[] }> {
    const id = params.id as string
    const list = this.store.quickCommands()
    if (!list.some((command) => command.id === id)) throw this.context.error('not-found', `no quick command ${id}`)
    return this.save(list.filter((command) => command.id !== id))
  }

  private picked(params: Params): Params {
    const out: Params = {}
    for (const field of FIELDS) if (params[field] !== undefined) out[field] = params[field]
    return out
  }

  /** The draft with a repo filled in for repo scope and its fields validated, including the agent's prompt mode. */
  private async checked(draft: Params, caller: PluginCaller): Promise<Params> {
    const out = { ...draft }
    if (out.scope === 'repo' && (typeof out.repo !== 'string' || out.repo.trim() === '')) {
      const repo = await this.layout.repoIdOf(await this.layout.resolveWorkspace(undefined, caller))
      if (repo === null) throw this.context.error('invalid-params', 'the floating workspace has no repo; pass repo')
      out.repo = repo
    }
    const problems = validateQuickCommand(out)
    if (problems.length > 0) throw this.context.error('invalid-params', problems.map((problem) => problem.message).join('; '))
    if (String(out.label ?? '').trim() === '' && String(out.command ?? '').trim() === '') {
      throw this.context.error('invalid-params', 'a quick command needs a label or a command')
    }
    if (out.kind === 'agent') {
      const agent = (await this.context.call('quirky.agents/get', { agent: String(out.agent).trim() })) as { promptMode?: string }
      if (agent.promptMode === 'stdin-after-start') {
        throw this.context.error('invalid-params', `agent ${String(out.agent).trim()} takes its prompt after it starts and can't run a quick command`)
      }
    }
    return out
  }

  private save(commands: QuickCommand[]): { commands: QuickCommand[] } {
    this.store.saveQuickCommands(commands)
    this.context.emit('quickCommands', {})
    return { commands }
  }

  private async run(params: Params, caller: PluginCaller): Promise<Record<string, unknown>> {
    const id = params.id as string
    const command = this.store.quickCommands().find((entry) => entry.id === id)
    if (!command) throw this.context.error('not-found', `no quick command ${id}`)
    if (!isQuickCommandComplete(command)) throw this.context.error('invalid-params', `quick command ${id} has no command to run`)
    const text = flattenQuickCommand(command.command)

    if (command.kind === 'terminal' && params.pane !== undefined) {
      const { session } = await this.layout.paneSession({ pane: params.pane })
      const record = (await this.context.call('quirky.session/get', { session })) as Session
      if (record.status === 'exited') throw this.context.error('conflict', `session ${session} has exited`)
      this.inputs.mark(session)
      this.context.pty.write(session, command.appendEnter ? `${text}\r` : text)
      await this.layout.rememberQuickCommand(params.pane as string, command.id)
      return { ok: true, session }
    }

    const workspace = await this.layout.resolveWorkspace(params.workspace, caller)
    const group = params.group as string | undefined
    const target = group === undefined ? {} : { group }
    if (command.kind === 'agent') {
      const created = await this.layout.createTab(workspace, { ...target, agent: command.agent!, prompt: command.command, quickCommand: command.id })
      return { ok: true, session: created.session.id, workspace: created.workspace }
    }
    const created = await this.layout.createTab(workspace, { ...target, title: command.label, quickCommand: command.id })
    this.inputs.mark(created.session.id)
    this.context.pty.write(created.session.id, `${text}\r`)
    return { ok: true, session: created.session.id, workspace: created.workspace }
  }
}
