import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveRepoConfigPath } from './repo-config-paths'

describe('resolveRepoConfigPath', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'repo-config-paths-'))
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('prefers the quirky name when both exist', () => {
    writeFileSync(join(repo, 'quirky.yaml'), '')
    writeFileSync(join(repo, 'orca.yaml'), '')
    mkdirSync(join(repo, '.quirky'))
    mkdirSync(join(repo, '.orca'))
    expect(resolveRepoConfigPath(repo, 'yaml')).toBe(join(repo, 'quirky.yaml'))
    expect(resolveRepoConfigPath(repo, 'dir')).toBe(join(repo, '.quirky'))
  })

  it('falls back to the orca name when only it exists', () => {
    writeFileSync(join(repo, 'orca.yaml'), '')
    mkdirSync(join(repo, '.orca'))
    expect(resolveRepoConfigPath(repo, 'yaml')).toBe(join(repo, 'orca.yaml'))
    expect(resolveRepoConfigPath(repo, 'dir')).toBe(join(repo, '.orca'))
  })

  it('returns null when neither exists', () => {
    expect(resolveRepoConfigPath(repo, 'yaml')).toBeNull()
    expect(resolveRepoConfigPath(repo, 'dir')).toBeNull()
  })
})
