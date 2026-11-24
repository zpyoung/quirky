import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readQuirkyCliBuildCommit, readQuirkyCliVersion } from './cli-version'

const temporaryDirectories: string[] = []

afterEach(() =>
  Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
)

describe('CLI version', () => {
  it('reads the package boundary beside the compiled CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quirky-cli-version-'))
    const runtimeDir = join(root, 'cli')
    temporaryDirectories.push(root)
    await mkdir(runtimeDir)
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ version: '1.4.178-rc.2', commit: 'b'.repeat(40) })
    )

    expect(readQuirkyCliVersion(runtimeDir)).toBe('1.4.178-rc.2')
    expect(readQuirkyCliBuildCommit(runtimeDir)).toBe('b'.repeat(40))
  })

  it('rejects missing, malformed, and non-string versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quirky-cli-version-invalid-'))
    const runtimeDir = join(root, 'cli')
    temporaryDirectories.push(root)
    await mkdir(runtimeDir)

    expect(readQuirkyCliVersion(runtimeDir)).toBeNull()
    await writeFile(join(root, 'package.json'), '{')
    expect(readQuirkyCliVersion(runtimeDir)).toBeNull()
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: 178 }))
    expect(readQuirkyCliVersion(runtimeDir)).toBeNull()
  })
})
