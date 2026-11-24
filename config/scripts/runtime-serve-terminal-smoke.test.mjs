import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveCli } from './runtime-serve-terminal-smoke.mjs'
import { packagedNodeRuntimePath } from './build-quirkyd-node.mjs'
import { currentTarget } from './server-build-target.mjs'
import { QUIRKYD_CLI_ENTRY_FILENAME } from '../../src/shared/quirkyd-artifacts.ts'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'quirky-smoke-cli-'))
  roots.push(root)
  const emitted = join(root, 'out', 'cli', 'index.js')
  mkdirSync(dirname(emitted), { recursive: true })
  writeFileSync(emitted, '')
  return root
}

it('drives Quirkyd with its packaged CLI and pinned Node even when a desktop CLI exists', () => {
  const root = checkout()
  const directory = join(root, 'out', 'quirkyd')
  const bundled = join(directory, QUIRKYD_CLI_ENTRY_FILENAME)
  mkdirSync(dirname(bundled), { recursive: true })
  writeFileSync(bundled, '')
  expect(resolveCli('quirkyd', root)).toEqual({
    command: packagedNodeRuntimePath(directory, currentTarget()),
    prefix: [bundled]
  })
})

it('fails if the packaged CLI is missing instead of using a stale desktop CLI', () => {
  expect(() => resolveCli('quirkyd', checkout())).toThrow('Missing packaged Quirkyd CLI')
})

it('retains the built desktop CLI for the Electron smoke', () => {
  const root = checkout()
  expect(resolveCli('electron', root)).toEqual({
    command: process.execPath,
    prefix: [join(root, 'out', 'cli', 'index.js')]
  })
})
