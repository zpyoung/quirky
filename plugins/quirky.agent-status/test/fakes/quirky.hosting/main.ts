import type { PluginContext } from '@quirky/protocol'

const reviews: Record<string, { kind: string; review?: { state: string }; reason?: string; message?: string }> = {
  wt1: { kind: 'found', review: { state: 'open' } },
  wt2: { kind: 'no-review' },
  wt3: { kind: 'unavailable', reason: 'authentication', message: 'authentication unavailable' }
}

export function activate(context: PluginContext): void {
  context.provide('method:quirky.hosting/forBranch', (params: Record<string, unknown>) => {
    const worktree = typeof params.worktree === 'string' ? params.worktree : ''
    return reviews[worktree] ?? { kind: 'no-review' }
  })
}
