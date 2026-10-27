import type { CliArgs, CliContext } from '@quirky/protocol'
import { TAB_COLORS } from '../layout/types'
import type { Workspace } from '../layout/types'
import { atMost, positional, showWorkspace, stringFlag, stringFlags, workspaceParam, type Handler } from './shared'
import { renderWorkspace } from './text'

const call = (ctx: CliContext, method: string, params: Record<string, unknown>) => ctx.call(`quirky.terminal/${method}`, params)

function closeTabs(which: 'others' | 'right' | 'left'): Handler {
  return async (args, ctx) => {
    atMost(args, ctx, 1)
    showWorkspace(ctx, await call(ctx, 'closeTabs', { tab: positional(args, ctx, 0, 'tab'), which }))
  }
}

function pinTab(pinned: boolean): Handler {
  return async (args, ctx) => {
    atMost(args, ctx, 1)
    showWorkspace(ctx, await call(ctx, 'pinTab', { tab: positional(args, ctx, 0, 'tab'), pinned }))
  }
}

function stepTab(offset: 1 | -1): Handler {
  return async (args, ctx) => {
    atMost(args, ctx, 0)
    showWorkspace(ctx, await call(ctx, 'activateTab', { offset }))
  }
}

async function moveTab(args: CliArgs, ctx: CliContext): Promise<void> {
  atMost(args, ctx, 1)
  const tab = positional(args, ctx, 0, 'tab')
  const { group, split, of } = { group: stringFlag(args, 'group'), split: stringFlag(args, 'split'), of: stringFlag(args, 'of') }
  const index = args.flags.index
  if (split !== undefined && (group !== undefined || index !== undefined)) throw ctx.usage('pass --group and --index, or --split, not both')
  if (split === undefined && of !== undefined) throw ctx.usage('--of needs --split')
  if (split === undefined && group === undefined) throw ctx.usage('pass --group (with --index) or --split')
  const params = split === undefined ? { tab, group, ...(index === undefined ? {} : { index }) } : { tab, split, ...(of === undefined ? {} : { of }) }
  showWorkspace(ctx, await call(ctx, 'moveTab', params))
}

async function activateTab(args: CliArgs, ctx: CliContext): Promise<void> {
  atMost(args, ctx, 1)
  const tab = args.positionals[0]
  const { index, group } = { index: args.flags.index, group: stringFlag(args, 'group') }
  if ((tab === undefined) === (index === undefined)) throw ctx.usage('pass <tab> or --index')
  if (tab !== undefined && group !== undefined) throw ctx.usage('--group goes with --index')
  if (group !== undefined && index === undefined) throw ctx.usage('--group needs --index')
  showWorkspace(ctx, await call(ctx, 'activateTab', tab !== undefined ? { tab } : { index, ...(group === undefined ? {} : { group }) }))
}

/** Handlers for `layout`, `tab …`, `group …` and `open-link`. */
export const workspaceCommands: Record<string, Handler> = {
  async layout(args, ctx) {
    atMost(args, ctx, 0)
    const { workspace } = (await call(ctx, 'workspace', workspaceParam(args, ctx))) as { workspace: Workspace }
    ctx.out.result(workspace, () => renderWorkspace(workspace))
  },

  async 'tab-new'(args, ctx) {
    atMost(args, ctx, 0)
    showWorkspace(ctx, await call(ctx, 'newTab', { ...workspaceParam(args, ctx), ...stringFlags(args, ['agent', 'cwd', 'title']) }))
  },

  async 'tab-close'(args, ctx) {
    atMost(args, ctx, 1)
    showWorkspace(ctx, await call(ctx, 'closeTab', { tab: positional(args, ctx, 0, 'tab') }))
  },
  'tab-close-others': closeTabs('others'),
  'tab-close-right': closeTabs('right'),
  'tab-close-left': closeTabs('left'),

  async 'tab-rename'(args, ctx) {
    atMost(args, ctx, 2)
    const params = { tab: positional(args, ctx, 0, 'tab'), title: positional(args, ctx, 1, 'title') }
    showWorkspace(ctx, await call(ctx, 'renameTab', params))
  },

  async 'tab-color'(args, ctx) {
    atMost(args, ctx, 2)
    const tab = positional(args, ctx, 0, 'tab')
    const color = positional(args, ctx, 1, 'color')
    if (!(TAB_COLORS as readonly string[]).includes(color)) throw ctx.usage(`<color> must be one of ${TAB_COLORS.join(', ')}, got "${color}"`)
    showWorkspace(ctx, await call(ctx, 'setTabColor', { tab, color }))
  },

  'tab-pin': pinTab(true),
  'tab-unpin': pinTab(false),

  async 'tab-reopen'(args, ctx) {
    atMost(args, ctx, 0)
    showWorkspace(ctx, await call(ctx, 'reopenTab', workspaceParam(args, ctx)))
  },

  'tab-move': moveTab,
  'tab-activate': activateTab,
  'tab-next': stepTab(1),
  'tab-previous': stepTab(-1),

  async 'group-close'(args, ctx) {
    atMost(args, ctx, 1)
    showWorkspace(ctx, await call(ctx, 'closeGroup', { group: positional(args, ctx, 0, 'group') }))
  },

  async 'group-resize'(args, ctx) {
    atMost(args, ctx, 1)
    const group = args.positionals[0]
    const split = stringFlag(args, 'split')
    const ratio = args.flags.ratio
    if ((group === undefined) === (split === undefined)) throw ctx.usage('pass <group> or --split')
    if (typeof ratio !== 'number') throw ctx.usage('missing required flag --ratio')
    showWorkspace(ctx, await call(ctx, 'resizeSplit', group !== undefined ? { group, share: ratio } : { split, ratio }))
  },

  async 'open-link'(args, ctx) {
    atMost(args, ctx, 1)
    const target = positional(args, ctx, 0, 'url-or-path')
    const reveal = args.flags.reveal === true
    const result = await call(ctx, 'openExternal', { target, ...(reveal ? { reveal } : {}) })
    ctx.out.result(result, () => `${reveal ? 'revealed' : 'opened'} ${target}`)
  }
}
