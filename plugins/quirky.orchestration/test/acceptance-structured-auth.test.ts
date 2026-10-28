import { chmodSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { waitForAsync } from '../../../packages/daemon/test/helpers'
import { startAgentsE2E } from '../../quirky.agents/test/support/e2e'
import { createCodexAppServerFixture } from '../../quirky.structured/test/fakes/codex-app-server'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts')
const LAUNCH_AGENT = join(import.meta.dir, 'launch-agent.ts')

test('AC9 a native structured provider inherits its launch lease and runs the real CLI', async () => {
  const e2e = await startAgentsE2E({ fakes: { codex: true }, extraEnv: { WORKER_TEST_CLI: CLI_MAIN } })
  try {
    const native = createCodexAppServerFixture(join(e2e.userHome, 'native-codex'))
    const codex = join(e2e.fakebin, 'codex')
    writeFileSync(codex, `#!${process.execPath}
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write('codex-cli 1.0.0 (isolated orchestration fixture)\\n')
  process.exit(0)
}
await import(${JSON.stringify(LAUNCH_AGENT)})
await import(${JSON.stringify(native.executable)})
`, { mode: 0o755 })
    chmodSync(codex, 0o755)
    await e2e.call('quirky.agents/refresh', {})
    await e2e.call('quirky.agents/setEnabled', { agent: 'codex', enabled: true })

    const session = await e2e.call('quirky.structured/create', {
      agent: 'codex',
      worktree: `path:${e2e.repo}`,
      prompt: 'run the real CLI using the structured launch environment'
    }) as Session
    expect(session.kind).toBe('structured')
    const controlDir = join(e2e.home, 'orchestration-terminal')
    const ready = join(controlDir, `${session.id}.ready`)
    await waitForAsync(() => existsSync(ready) ? true : undefined, 15_000)

    const retryRequest = crypto.randomUUID()
    const correlationId = crypto.randomUUID()
    appendFileSync(join(controlDir, `${session.id}.requests.jsonl`), JSON.stringify({
      id: correlationId,
      args: [
        'orchestration',
        'run-create',
        '--objective',
        'structured child authenticated by its inherited lease',
        '--retry-request',
        retryRequest,
        '--json'
      ]
    }) + String.fromCharCode(10))
    const reply = await waitForAsync(() => {
      const path = join(controlDir, `${correlationId}.reply.json`)
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { code: number; stdout: string; stderr: string } : undefined
    }, 30_000)
    expect(reply.code).toBe(0)
    expect(reply.stderr).toBe('')
    const result = JSON.parse(reply.stdout) as {
      run: { id: string; coordinatorSessionId: string | null }
      mutation: { requestId: string; replayed: boolean }
    }
    expect(result.run.coordinatorSessionId).toBe(session.id)
    expect(result.mutation.replayed).toBe(false)
    expect(result.mutation.requestId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    expect(native.requests().some((request) => request.method === 'turn/start')).toBe(true)
  } finally {
    await e2e.cleanup()
  }
}, 90_000)
