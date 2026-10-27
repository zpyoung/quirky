import type { CliArgs, CliContext } from '@quirky/protocol'
import type { FloatingState, QuickCommand } from '../layout/types'
import { atMost, paneIdOf, positional, requiredNumber, showWorkspace, stringFlag, stringFlags, workspaceParam, type Handler } from './shared'
import { floatingPairs, quickCommandRows } from './text'

const call = (ctx: CliContext, method: string, params: Record<string, unknown>) => ctx.call(`quirky.terminal/${method}`, params)

const COMMAND_TABLE = ['ID', 'LABEL', 'KIND', 'SCOPE', 'COMMAND']

function showCommands(ctx: CliContext, result: unknown): void {
  ctx.out.result(result, () => ctx.format.table(COMMAND_TABLE, quickCommandRows((result as { commands: QuickCommand[] }).commands)))
}

/** The quick-command fields given as flags, as the params `addQuickCommand` and `updateQuickCommand` take. */
function commandFields(args: CliArgs, ctx: CliContext): Record<string, unknown> {
  if (args.flags['no-enter'] === true && args.flags.enter === true) throw ctx.usage('pass --enter or --no-enter, not both')
  const appendEnter = args.flags['no-enter'] === true ? false : args.flags.enter === true ? true : undefined
  return {
    ...stringFlags(args, ['label', 'command', 'kind', 'agent', 'scope', 'repo']),
    ...(appendEnter === undefined ? {} : { appendEnter })
  }
}

async function addCommand(args: CliArgs, ctx: CliContext): Promise<void> {
  atMost(args, ctx, 0)
  const fields = commandFields(args, ctx)
  for (const name of ['label', 'command']) if (fields[name] === undefined) throw ctx.usage(`missing required flag --${name}`)
  showCommands(ctx, await call(ctx, 'addQuickCommand', fields))
}

async function updateCommand(args: CliArgs, ctx: CliContext): Promise<void> {
  atMost(args, ctx, 1)
  const id = positional(args, ctx, 0, 'id')
  const fields = commandFields(args, ctx)
  if (Object.keys(fields).length === 0) throw ctx.usage('nothing to change; pass at least one of --label, --command, --kind, --agent, --scope, --repo, --enter, --no-enter')
  showCommands(ctx, await call(ctx, 'updateQuickCommand', { id, ...fields }))
}

async function runCommand(args: CliArgs, ctx: CliContext): Promise<void> {
  atMost(args, ctx, 1)
  const id = positional(args, ctx, 0, 'id')
  const pane = stringFlag(args, 'pane')
  const target = pane === undefined ? {} : { pane: await paneIdOf(pane, ctx) }
  const result = (await call(ctx, 'runQuickCommand', { id, ...target })) as { session: string; workspace?: unknown }
  if (result.workspace) showWorkspace(ctx, result)
  else ctx.out.result(result, () => `ran ${id} in ${result.session}`)
}

function floatingChange(change: Record<string, unknown>): Handler {
  return async (args, ctx) => {
    atMost(args, ctx, 0)
    showFloating(ctx, await call(ctx, 'setFloating', change))
  }
}

function showFloating(ctx: CliContext, state: unknown): void {
  ctx.out.result(state, () => ctx.format.record(floatingPairs(state as FloatingState)))
}

/** Handlers for `quick-command …` and `floating …`. */
export const quickFloatingCommands: Record<string, Handler> = {
  async 'quick-command-list'(args, ctx) {
    atMost(args, ctx, 0)
    showCommands(ctx, await call(ctx, 'quickCommands', { ...(args.flags.all === true ? { all: true } : {}), ...workspaceParam(args, ctx) }))
  },
  'quick-command-add': addCommand,
  'quick-command-update': updateCommand,

  async 'quick-command-remove'(args, ctx) {
    atMost(args, ctx, 1)
    showCommands(ctx, await call(ctx, 'removeQuickCommand', { id: positional(args, ctx, 0, 'id') }))
  },

  'quick-command-run': runCommand,

  async 'floating-state'(args, ctx) {
    atMost(args, ctx, 0)
    showFloating(ctx, await call(ctx, 'floating', {}))
  },
  'floating-show': floatingChange({ open: true }),
  'floating-hide': floatingChange({ open: false }),
  'floating-maximize': floatingChange({ maximized: true }),
  'floating-restore': floatingChange({ maximized: false }),

  async 'floating-toggle'(args, ctx) {
    atMost(args, ctx, 0)
    const { open } = (await call(ctx, 'floating', {})) as FloatingState
    showFloating(ctx, await call(ctx, 'setFloating', { open: !open }))
  },

  async 'floating-bounds'(args, ctx) {
    atMost(args, ctx, 0)
    const [x, y, width, height] = (['x', 'y', 'width', 'height'] as const).map((name) => requiredNumber(args, ctx, name))
    showFloating(ctx, await call(ctx, 'setFloating', { bounds: { x, y, width, height } }))
  }
}
