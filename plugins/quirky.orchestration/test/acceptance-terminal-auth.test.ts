import { chmodSync, existsSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { startAgentsE2E } from '../../quirky.agents/test/support/e2e'
import { readCliResult } from './fixture'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts')
const LAUNCH_AGENT = join(import.meta.dir, 'launch-agent.ts')

test('AC9 a real terminal launch passes its inherited kernel identity to the generated CLI', async () => {
  const e2e = await startAgentsE2E({ fakes: { claude: true }, extraEnv: { WORKER_TEST_CLI: CLI_MAIN } })
  try {
    const claude = join(e2e.fakebin, 'claude')
    writeFileSync(claude, `#!${process.execPath}\nimport ${JSON.stringify(LAUNCH_AGENT)}\n`, { mode: 0o755 })
    chmodSync(claude, 0o755)
    const session = await e2e.call('quirky.session/create', {
      agent: 'claude',
      worktree: 'floating',
      cwd: e2e.repo
    }) as Session
    const controlDir = join(e2e.home, 'orchestration-terminal')
    const ready = join(controlDir, `${session.id}.ready`)
    await waitFor(() => existsSync(ready) ? true : undefined, 15_000)

    const requestId = crypto.randomUUID()
    const correlationId = crypto.randomUUID()
    appendFileSync(join(controlDir, `${session.id}.requests.jsonl`), JSON.stringify({
      id: correlationId,
      args: [
        'orchestration',
        'run-create',
        '--objective',
        'terminal child authenticated by its inherited launch environment',
        '--retry-request',
        requestId,
        '--json'
      ]
    }) + '\n')
    const reply = await waitFor(
      () => readCliResult(join(controlDir, `${correlationId}.reply.json`)),
      30_000
    )
    expect(reply.code).toBe(0)
    expect(reply.stderr).toBe('')
    const result = JSON.parse(reply.stdout) as {
      run: { id: string; coordinatorSessionId: string | null }
      mutation: { requestId: string; replayed: boolean }
    }
    expect(result.run.coordinatorSessionId).toBe(session.id)
    expect(result.mutation.replayed).toBe(false)
    expect(result.mutation.requestId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  } finally {
    await e2e.cleanup()
  }
}, 60_000)
