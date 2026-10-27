import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalPathForEvidence, fileExistsSafely } from '../src/daemon/content'

let scratch: string | undefined
let realRoot: string
let aliasRoot: string
let outsideRoot: string
let inRootFile: string
let outsideFile: string

beforeEach(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'quirky-ledger-evidence-paths-')))
  const root = join(scratch, 'root')
  aliasRoot = join(scratch, 'alias')
  outsideRoot = join(scratch, 'outside')
  mkdirSync(root)
  mkdirSync(outsideRoot)
  inRootFile = join(root, 'present.ts')
  outsideFile = join(outsideRoot, 'secret.ts')
  writeFileSync(inRootFile, 'export const inside = true\n')
  writeFileSync(outsideFile, 'outside evidence\n')
  symlinkSync(root, aliasRoot)
  symlinkSync(outsideRoot, join(root, 'escape'))
  realRoot = realpathSync.native(root)
})

afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('evidence path filesystem boundaries', () => {
  test('resolves relative, absolute-alias and absolute-canonical in-root paths to the canonical target', () => {
    const canonicalFile = join(realRoot, 'present.ts')
    const absoluteAliasFile = join(aliasRoot, 'present.ts')
    const absoluteCanonicalFile = join(realRoot, 'present.ts')

    expect(realpathSync.native(inRootFile)).toBe(canonicalFile)
    expect(realpathSync.native(absoluteAliasFile)).toBe(canonicalFile)
    expect(canonicalPathForEvidence(aliasRoot, 'present.ts')).toBe(canonicalFile)
    expect(canonicalPathForEvidence(aliasRoot, absoluteAliasFile)).toBe(canonicalFile)
    expect(canonicalPathForEvidence(aliasRoot, absoluteCanonicalFile)).toBe(canonicalFile)
  })

  test('reports present and missing in-root evidence as true and false', () => {
    expect(fileExistsSafely(aliasRoot, 'present.ts')).toBe(true)
    expect(fileExistsSafely(aliasRoot, 'missing.ts')).toBe(false)
  })

  test('rejects lexically outside-root paths', () => {
    const relativeOutsideFile = join(aliasRoot, '..', 'outside', 'secret.ts')

    expect(realpathSync.native(outsideFile)).toBe(outsideFile)
    expect(canonicalPathForEvidence(aliasRoot, relativeOutsideFile)).toBeNull()
    expect(fileExistsSafely(aliasRoot, relativeOutsideFile)).toBeNull()
  })

  test('rejects existing and missing-leaf paths through an in-root symlink escape', () => {
    const existingEscape = join(aliasRoot, 'escape', 'secret.ts')
    const missingEscape = join(aliasRoot, 'escape', 'missing.ts')

    expect(realpathSync.native(existingEscape)).toBe(outsideFile)
    expect(canonicalPathForEvidence(aliasRoot, existingEscape)).toBeNull()
    expect(fileExistsSafely(aliasRoot, existingEscape)).toBeNull()
    expect(canonicalPathForEvidence(aliasRoot, missingEscape)).toBeNull()
    expect(fileExistsSafely(aliasRoot, missingEscape)).toBeNull()
  })
})
