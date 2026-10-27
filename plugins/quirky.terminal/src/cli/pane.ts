import type { CliArgs, CliContext } from '@quirky/protocol'
import { findPane, groupsInOrder } from '../layout/tree'
import type { Workspace } from '../layout/types'
import { atMost, paneIdOf, positional, requiredNumber, showWorkspace, stringFlag, workspaceParam, type Handler } from './shared'

const call = (ctx: CliContext, method: string, params: Record<string, unknown>) => ctx.call(`quirky.terminal/${method}`, params)

function onPane(method: string, extra: Record<string, unknown> = {}): Handler {
  return async (args, ctx) => {
    atMost(args, ctx, 1)
    showWorkspace(ctx, await call(ctx, method, { pane: await paneIdOf(args.positionals[0], ctx), ...extra }))
  }
}

function ptyAction(method: 'clearPane' | 'resetPane', done: string): Handler {
  return async (args, ctx) => {
    atMost(args, ctx, 1)
    const pane = await paneIdOf(args.positionals[0], ctx)
    ctx.out.result(await call(ctx, method, { pane }), () => `${done} ${pane}`)
  }
}

async function focusPane(args: CliArgs, ctx: CliContext): Promise<void> {
  atMost(args, ctx, 1)
  const next = args.flags.next === true
  const previous = args.flags.previous === true
  const pane = args.positionals[0]
  if ([pane !== undefined, next, previous].filter(Boolean).length !== 1) throw ctx.usage('pass <pane>, --next or --previous')
  const params = pane === undefined ? { offset: next ? 1 : -1 } : { pane: await paneIdOf(pane, ctx) }
  showWorkspace(ctx, await call(ctx, 'focusPane', params))
}

async function titlePane(args: CliArgs, ctx: CliContext): Promise<void> {
  atMost(args, ctx, 2)
  if (args.positionals.length === 0) throw ctx.usage('missing <title>')
  const title = args.positionals.length === 1 ? args.positionals[0]! : args.positionals[1]!
  const pane = await paneIdOf(args.positionals.length === 2 ? args.positionals[0] : undefined, ctx)
  showWorkspace(ctx, await call(ctx, 'setPaneTitle', { pane, title }))
}

async function equalizePane(args: CliArgs, ctx: CliContext): Promise<void> {
  atMost(args, ctx, 0)
  const given = stringFlag(args, 'tab')
  let tab = given
  if (tab === undefined) {
    const session = ctx.env.QUIRKY_SESSION_ID
    if (!session) throw ctx.usage('no tab; pass --tab or set QUIRKY_SESSION_ID')
    tab = ((await call(ctx, 'paneOf', { session })) as { tab: string }).tab
  }
  showWorkspace(ctx, await call(ctx, 'equalize', { tab }))
}

async function movePane(args: CliArgs, ctx: CliContext): Promise<void> {
  atMost(args, ctx, 1)
  const source = positional(args, ctx, 0, 'pane')
  const toPane = stringFlag(args, 'to-pane')
  const toTab = stringFlag(args, 'to-tab')
  const edge = stringFlag(args, 'edge')
  if ((toPane === undefined) === (toTab === undefined)) throw ctx.usage('pass --to-pane (with --edge) or --to-tab')
  if (toPane !== undefined && edge === undefined) throw ctx.usage('--to-pane needs --edge')
  if (toTab !== undefined && edge !== undefined) throw ctx.usage('--edge goes with --to-pane')
  const pane = await paneIdOf(source, ctx)
  const params = toPane === undefined ? { pane, toTab } : { pane, toPane: await paneIdOf(toPane, ctx), edge }
  showWorkspace(ctx, await call(ctx, 'movePane', params))
}

/** Looks for `paneId` in the given workspace selectors in turn; null when none holds it. */
async function locatePane(ctx: CliContext, paneId: string, selectors: (string | undefined)[]) {
  for (const selector of selectors) {
    const { workspace } = (await call(ctx, 'workspace', selector === undefined ? {} : { workspace: selector })) as { workspace: Workspace }
    for (const group of groupsInOrder(workspace.root)) {
      for (const tab of group.tabs) {
        const pane = findPane(tab.root, paneId)
        if (pane) {
          const active = workspace.activeGroup === group.id && group.activeTab === tab.id && tab.activePane === pane.id
          return { workspace: workspace.id, tab: tab.id, group: group.id, pane, active }
        }
      }
    }
  }
  return null
}

async function getPane(args: CliArgs, ctx: CliContext): Promise<void> {
  atMost(args, ctx, 1)
  const pane = await paneIdOf(args.positionals[0], ctx)
  const scope = workspaceParam(args, ctx).workspace
  const found = await locatePane(ctx, pane, scope === undefined ? [undefined, 'floating'] : [scope])
  if (!found) throw ctx.fail(`no pane ${pane}`)
  ctx.out.result(found, () =>
    ctx.format.record([
      ['pane', found.pane.id],
      ['session', found.pane.session],
      ['tab', found.tab],
      ['group', found.group],
      ['workspace', found.workspace],
      ['title', found.pane.title ?? '-'],
      ['active', String(found.active)],
      ['exit', found.pane.exit ? String(found.pane.exit.code ?? found.pane.exit.signal) : '-']
    ])
  )
}

/** Handlers for `pane …`. */
export const paneCommands: Record<string, Handler> = {
  async 'pane-split'(args, ctx) {
    atMost(args, ctx, 1)
    const direction = stringFlag(args, 'direction')
    if (direction === undefined) throw ctx.usage('missing required flag --direction')
    showWorkspace(ctx, await call(ctx, 'splitPane', { pane: await paneIdOf(args.positionals[0], ctx), direction }))
  },
  'pane-close': onPane('closePane'),
  'pane-restart': onPane('restartPane'),
  'pane-focus': focusPane,
  'pane-title': titlePane,
  'pane-expand': onPane('expandPane', { expanded: true }),
  'pane-collapse': onPane('expandPane', { expanded: false }),
  'pane-equalize': equalizePane,

  async 'pane-resize'(args, ctx) {
    atMost(args, ctx, 1)
    const share = requiredNumber(args, ctx, 'ratio')
    showWorkspace(ctx, await call(ctx, 'resizeSplit', { pane: await paneIdOf(args.positionals[0], ctx), share }))
  },

  'pane-move': movePane,
  'pane-clear': ptyAction('clearPane', 'cleared'),
  'pane-reset': ptyAction('resetPane', 'reset'),
  'pane-get': getPane
}
