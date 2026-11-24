import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn<(spec: Record<string, unknown>) => ChildProcess>()

vi.mock('@orca/process-host', () => ({ spawnProcess: spawnMock }))
vi.mock('./bundled-ripgrep-path', () => ({
  bundledRipgrepCommand: () => '/install/ripgrep/darwin-arm64/rg'
}))

const { spawnBundledRipgrep } = await import('./bundled-ripgrep-spawn')

describe('spawnBundledRipgrep', () => {
  it("spawns this host's bundled binary for a local workspace", () => {
    spawnBundledRipgrep(['--files'], { cwd: '/repo' })

    const [spec] = spawnMock.mock.calls[0]
    expect(spec.program).toBe('/install/ripgrep/darwin-arm64/rg')
    expect(spec.args).toEqual(['--files'])
    expect(spec.cwd).toBe('/repo')
  })
})
