import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

const spawnMock =
  vi.fn<(command: string, args: string[], options: Record<string, unknown>) => ChildProcess>()

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('./bundled-ripgrep-path', () => ({
  bundledRipgrepCommand: () => '/install/ripgrep/darwin-arm64/rg'
}))

const { spawnBundledRipgrep } = await import('./bundled-ripgrep-spawn')

describe('spawnBundledRipgrep', () => {
  it("spawns this host's bundled binary for a local workspace", () => {
    spawnBundledRipgrep(['--files'], { cwd: '/repo' })

    const [command, args, options] = spawnMock.mock.calls[0]
    expect(command).toBe('/install/ripgrep/darwin-arm64/rg')
    expect(args).toEqual(['--files'])
    expect(options.cwd).toBe('/repo')
  })
})
