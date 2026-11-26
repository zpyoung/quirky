import { describe, expect, it, vi } from 'vitest'
import type { QuirkyRuntimeService } from '../quirky-runtime'
import type { RpcContext } from './core'
import { getDestructivePreviewer } from './destructive-previewers'
import { resolveTargetWorktreeId } from './public-call-resolvers'

type FakeRuntime = {
  statRuntimeFile: ReturnType<typeof vi.fn>
  showTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
}

function createContext(overrides: Partial<FakeRuntime> = {}): {
  ctx: RpcContext
  runtime: FakeRuntime
} {
  const runtime: FakeRuntime = {
    statRuntimeFile: vi.fn(async () => ({ size: 12, isDirectory: false, mtime: 1 })),
    showTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: 'wt-1',
      path: '/w/feature',
      folderWorkspace: null
    })),
    ...overrides
  }
  // SAFETY: the previewers read only these runtime members.
  return { ctx: { runtime: runtime as unknown as QuirkyRuntimeService }, runtime }
}

async function preview(method: string, params: unknown, ctx: RpcContext): Promise<string[]> {
  const previewer = getDestructivePreviewer(method)
  if (!previewer) {
    throw new Error(`no previewer for ${method}`)
  }
  return previewer(params, ctx)
}

describe('destructive previewers for file and workspace methods', () => {
  it('says an existing file will be replaced, naming the workspace and the file', async () => {
    const { ctx } = createContext()

    const effects = await preview(
      'files.write',
      { worktree: 'id:wt-1', relativePath: 'src/a.ts', content: 'hello' },
      ctx
    )

    expect(effects).toHaveLength(1)
    expect(effects[0]).toContain('src/a.ts exists')
    expect(effects[0]).toContain('/w/feature')
    expect(effects[0]).toContain('replaced')
  })

  it('says a missing file will be created', async () => {
    const { ctx } = createContext({
      statRuntimeFile: vi.fn(async () => {
        throw new Error('ENOENT: no such file or directory')
      })
    })

    const effects = await preview(
      'files.write',
      { worktree: 'id:wt-1', relativePath: 'new.txt', content: 'hello' },
      ctx
    )

    expect(effects[0]).toMatch(/^creates new\.txt in the workspace at \/w\/feature/)
  })

  it('does not claim the file is new when the stat failed for another reason', async () => {
    const { ctx } = createContext({
      statRuntimeFile: vi.fn(async () => {
        throw new Error('permission denied')
      })
    })

    const effects = await preview(
      'files.write',
      { worktree: 'id:wt-1', relativePath: 'locked.txt', content: 'x' },
      ctx
    )

    expect(effects[0]).toContain('replacing it if it exists')
  })

  it('names what a delete removes, including a directory with its contents', async () => {
    const { ctx } = createContext({
      statRuntimeFile: vi.fn(async () => ({ size: 0, isDirectory: true, mtime: 1 }))
    })

    const effects = await preview(
      'files.delete',
      { worktree: 'id:wt-1', relativePath: 'dist', recursive: true },
      ctx
    )

    expect(effects[0]).toBe(
      'deletes the directory dist in the workspace at /w/feature and everything inside it'
    )
  })

  it('falls back to the selector when the workspace no longer resolves', async () => {
    const { ctx } = createContext({
      showTerminalWorkspaceLaunchScope: vi.fn(async () => {
        throw new Error('selector_not_found')
      })
    })

    const effects = await preview('files.delete', { worktree: 'gone', relativePath: 'a.txt' }, ctx)

    expect(effects[0]).toBe('deletes a.txt from the workspace gone')
  })

  it('lists the discarded paths and caps a long list', async () => {
    const { ctx } = createContext()
    const filePaths = Array.from({ length: 12 }, (_, index) => `f${index}.ts`)

    const effects = await preview('git.bulkDiscard', { worktree: 'id:wt-1', filePaths }, ctx)

    expect(effects[0]).toContain('12 files')
    expect(effects).toContain('- f0.ts')
    expect(effects).not.toContain('- f11.ts')
    expect(effects.at(-1)).toBe('- and 2 more')
  })

  it('says a forced worktree removal drops uncommitted changes', async () => {
    const { ctx } = createContext()

    const forced = await preview('worktree.rm', { worktree: 'old-spike', force: true }, ctx)
    const plain = await preview('worktree.rm', { worktree: 'old-spike' }, ctx)

    expect(forced[0]).toContain('/w/feature')
    expect(forced).toContain('--force discards its uncommitted changes')
    expect(plain).toHaveLength(1)
  })

  it('falls back to a generic effect when the params do not parse', async () => {
    const { ctx } = createContext()

    expect(await preview('files.write', { worktree: 'id:wt-1' }, ctx)).toEqual([
      'files.write is destructive'
    ])
  })
})

describe('resolveTargetWorktreeId', () => {
  const runtime = (id: string | Error) => ({
    showTerminalWorkspaceLaunchScope: vi.fn(async () => {
      if (id instanceof Error) {
        throw id
      }
      return { id }
    })
  })

  it('prefers an explicit id over any selector', async () => {
    const fake = runtime('wt-x')

    expect(await resolveTargetWorktreeId(fake, { worktreeId: 'wt-1', worktree: 'feature' })).toBe(
      'wt-1'
    )
    expect(fake.showTerminalWorkspaceLaunchScope).not.toHaveBeenCalled()
  })

  it('resolves a plain selector and returns undefined when it does not resolve', async () => {
    expect(await resolveTargetWorktreeId(runtime('wt-2'), { workspace: 'feature' })).toBe('wt-2')
    expect(
      await resolveTargetWorktreeId(runtime(new Error('selector_not_found')), { workspace: 'x' })
    ).toBeUndefined()
  })

  it('returns undefined for params that name no workspace', async () => {
    expect(await resolveTargetWorktreeId(runtime('wt-2'), undefined)).toBeUndefined()
    expect(await resolveTargetWorktreeId(runtime('wt-2'), { actionId: 'a' })).toBeUndefined()
  })
})
