import type { PluginContext, Worktree } from '@quirky/protocol'

declare global {
  /** The worktrees the fake `quirky.worktree/resolve` knows; tests assign it before calling. */
  var __QUIRKY_TEST_WORKTREES__: Worktree[] | undefined
}

type ResolveParams = { selector: string; cwd?: string; worktreeId?: string }

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

/** Stands in for the real `quirky.worktree/resolve` with the selector forms the git tests use. */
export function activate(context: PluginContext): void {
  context.provide('method:quirky.worktree/resolve', (params: ResolveParams) => {
    const all = globalThis.__QUIRKY_TEST_WORKTREES__ ?? []
    const pick = (matches: Worktree[], selector: string) => {
      if (matches.length === 1) return matches[0]
      if (matches.length > 1) throw context.error('conflict', `${selector} matches ${matches.length} worktrees`)
      return undefined
    }
    const { selector } = params
    let found: Worktree | undefined
    if (selector === 'current' || selector === 'active') {
      found =
        all.find((w) => w.id === params.worktreeId) ??
        all
          .filter((w) => params.cwd !== undefined && inside(params.cwd, w.path))
          .sort((a, b) => b.path.length - a.path.length)[0]
    } else if (selector.startsWith('id:')) found = pick(all.filter((w) => w.id === selector.slice(3)), selector)
    else if (selector.startsWith('name:')) found = pick(all.filter((w) => w.name === selector.slice(5)), selector)
    else if (selector.startsWith('branch:')) found = pick(all.filter((w) => w.branch === selector.slice(7)), selector)
    else if (selector.startsWith('path:')) {
      const path = selector.slice(5)
      found = all.filter((w) => inside(path, w.path)).sort((a, b) => b.path.length - a.path.length)[0]
    } else {
      found = pick(all.filter((w) => w.id === selector), selector) ?? pick(all.filter((w) => w.name === selector), selector)
    }
    if (!found) throw context.error('not-found', `no worktree matches ${selector}`)
    return found
  })
}
