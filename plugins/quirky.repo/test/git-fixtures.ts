import { afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcError, type QuirkyClient } from '@quirky/protocol'

/** Real-git tests must not read the user's git config; call inside a `describe` or at file level. */
export function isolateGitConfig(): { scratch: () => string } {
  const saved: Record<string, string | undefined> = {}
  let root = ''
  beforeAll(() => {
    for (const [key, value] of Object.entries({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })) {
      saved[key] = process.env[key]
      process.env[key] = value
    }
    root = realpathSync(mkdtempSync(join(tmpdir(), 'qd-repo-')))
  })
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })
  let counter = 0
  return { scratch: () => join(root, `s${counter++}`) }
}

export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: process.env })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

/** A repository on `main` with one commit; `files` are committed with it. */
export function makeRepo(dir: string, files: Record<string, string> = { 'a.txt': 'one\n' }): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  commitFiles(dir, files)
  return realpathSync(dir)
}

export function commitFiles(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'update')
}

export type Failure = { code: number; message: string; data: { reason?: string } & Record<string, unknown> }

export async function failure(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise
  } catch (error) {
    const rpc = error as RpcError
    return { code: rpc.code, message: rpc.message, data: (rpc.data ?? {}) as Failure['data'] }
  }
  throw new Error('expected the call to fail')
}

export const call = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)
