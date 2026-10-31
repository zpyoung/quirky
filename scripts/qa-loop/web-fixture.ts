#!/usr/bin/env bun
/**
 * Serves a worktree's built renderer from a private daemon with real Git fixtures, so a QA agent or a
 * fix session can drive the app in a headless browser without opening a window on the Mac.
 *
 *   bun scripts/qa-loop/web-fixture.ts <out-dir>
 *
 * Writes `<out-dir>/fixture.json` ({ url, port, home, repo, pid }), prints `READY <path>` and runs until
 * SIGTERM, which stops the daemon and removes its home. The home is isolated, HOME included, so nothing
 * here can reach the user's Quirky, but agents have no login: goals that need a real agent can't run.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { connectDaemon, isDaemonAlive, readRuntime } from '../../packages/protocol/src/node/index'
import { createProcessScope } from '../test-support/process-scope'
import {
  createIsolatedRuntimeEnvironment,
  prepareCaptureFixtureHome,
  registerCaptureFixtures,
  type FixtureRpcClient
} from '../ui-review/fixtures'

const DAEMON_START_ATTEMPTS = 300
const FIXTURE_TIMEOUT_MS = 60_000

const repoRoot = resolve(import.meta.dir, '../..')
const out = process.argv[2]
if (!out) {
  console.error('usage: web-fixture.ts <out-dir>')
  process.exit(2)
}
mkdirSync(out, { recursive: true })
const uiDir = join(resolve(out), 'ui-dist')
const scope = createProcessScope()

async function waitForRuntime(): Promise<NonNullable<ReturnType<typeof readRuntime>>> {
  for (let attempt = 0; attempt < DAEMON_START_ATTEMPTS; attempt++) {
    const runtime = readRuntime(scope.home)
    if (runtime && (await isDaemonAlive(runtime, 500))) return runtime
    await Bun.sleep(100)
  }
  throw new Error('the fixture daemon did not start')
}

async function start(): Promise<() => void> {
  const env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot, uiDir })
  const build = Bun.spawn([process.execPath, join(repoRoot, 'packages/ui/build.ts')], {
    cwd: repoRoot,
    env: { ...env, QUIRKY_UI_OUT: uiDir },
    stdout: 'inherit',
    stderr: 'inherit'
  })
  if (await build.exited) throw new Error('the renderer build failed')
  const prepared = await prepareCaptureFixtureHome(scope.home, { timeoutMs: FIXTURE_TIMEOUT_MS, env })
  scope.spawn([process.execPath, join(repoRoot, 'packages/daemon/src/main.ts')], {
    cwd: repoRoot,
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const runtime = await waitForRuntime()
  const client = await connectDaemon({ home: scope.home, role: 'cli', name: 'qa-web-fixture', autostart: false })
  const status = (await client.callAny('status.get', {})) as { home?: string }
  if (status.home !== scope.home) throw new Error('the fixture daemon reports a different home')
  const fixtures = await registerCaptureFixtures(client as unknown as FixtureRpcClient, prepared, { timeoutMs: FIXTURE_TIMEOUT_MS })
  const path = join(out!, 'fixture.json')
  const url = `http://127.0.0.1:${runtime.port}/#token=${encodeURIComponent(runtime.token)}`
  writeFileSync(path, JSON.stringify({ url, port: runtime.port, home: scope.home, repo: fixtures.primaryWorktree.path, pid: process.pid }, null, 2))
  console.log('READY', path)
  return () => client.close()
}

let closeClient = () => {}
const stop = async (code: number) => {
  try {
    closeClient()
  } catch {
    // the daemon may already be gone; cleanup below still has to run
  }
  await scope.cleanup()
  process.exit(code)
}
process.on('SIGTERM', () => void stop(0))
process.on('SIGINT', () => void stop(0))

try {
  closeClient = await start()
} catch (error) {
  console.error(error)
  await stop(1)
}
await new Promise(() => {})
