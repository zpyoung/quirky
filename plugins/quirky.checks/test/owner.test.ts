import { test, expect } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeTempHome, startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'

/** A revoked caller cannot use context.call during deactivate, so checks owns cancellation. */
test('disabling a creating plugin kills its check but leaves client-owned checks running', async () => {
  const home = makeTempHome('checks-owner-')
  const oldHome = process.env.HOME
  const oldQuirkyHome = process.env.QUIRKY_HOME
  process.env.HOME = home
  process.env.QUIRKY_HOME = home
  let harness: Harness | undefined
  const pids: number[] = []
  const pending: Promise<unknown>[] = []
  const ownerId = 'acme.check-owner'
  try {
    const builtins = join(home, 'builtins')
    mkdirSync(builtins)
    for (const id of ['quirky.repo', 'quirky.worktree', 'quirky.checks']) {
      symlinkSync(resolve(import.meta.dir, '../..', id), join(builtins, id))
    }
    writePlugin(join(home, 'plugins'), {
      id: ownerId, name: 'Check owner', version: '1.0.0', main: 'main.ts',
      activation: 'lazy', dependencies: ['quirky.checks'],
      contributes: { method: [{ id: 'start', params: { type: 'object', additionalProperties: true } }] }
    }, {
      'main.ts': `import type { PluginContext } from '@quirky/protocol'
export function activate(context: PluginContext) {
  context.provide('method:acme.check-owner/start', (params: Record<string, unknown>) => context.call('quirky.checks/run', params))
}
`
    })
    harness = await startHarness({ home, builtinPluginsDir: builtins })
    const client = await harness.connect()
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    for (const [method, id] of [['acme.check-owner/start', 'owned'], ['quirky.checks/run', 'client']] as const) {
      // A real child must stay alive until OS process cancellation; parent fake timers cannot control it.
      const marker = join(home, `${id}.pid`)
      const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`
      pending.push(client.callAny(method, {
        checkId: id, cwd: home, timeoutSeconds: 30, command: `${quote(process.execPath)} -e ${quote(source)}`
      }).catch((error: unknown) => error))
      const pid = await waitFor(() => existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : undefined, 5000)
      pids.push(pid)
    }
    await client.call('plugin.disable', { id: ownerId })
    await waitFor(() => {
      try { process.kill(pids[0]!, 0); return undefined } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
        throw error
      }
    }, 3000)
    expect((await client.call('plugin.list', {})).find((plugin) => plugin.id === ownerId)?.state).toBe('disabled')
    expect(process.kill(pids[1]!, 0)).toBe(true)
  } finally {
    if (harness) {
      const client = await harness.connect()
      await Promise.all(['owned', 'client'].map((checkId) => client.callAny('quirky.checks/cancel', { checkId }).catch(() => undefined)))
      await Promise.allSettled(pending)
      await harness.cleanup()
    }
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* owned child already stopped */ } }
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldQuirkyHome === undefined) delete process.env.QUIRKY_HOME
    else process.env.QUIRKY_HOME = oldQuirkyHome
    rmSync(home, { recursive: true, force: true })
  }
}, 20_000)

test('a startup plugin can run a check and expose its evidence during activation', async () => {
  const home = makeTempHome('checks-startup-owner-')
  const oldHome = process.env.HOME
  const oldQuirkyHome = process.env.QUIRKY_HOME
  process.env.HOME = home
  process.env.QUIRKY_HOME = home
  let harness: Harness | undefined
  const ownerId = 'acme.startup-check-owner'
  try {
    const builtins = join(home, 'builtins')
    mkdirSync(builtins)
    for (const id of ['quirky.repo', 'quirky.worktree', 'quirky.checks']) {
      symlinkSync(resolve(import.meta.dir, '../..', id), join(builtins, id))
    }
    writePlugin(join(home, 'plugins'), {
      id: ownerId, name: 'Startup check owner', version: '1.0.0', main: 'main.ts',
      activation: 'startup', dependencies: ['quirky.checks'],
      contributes: { method: [{ id: 'evidence', params: { type: 'object', additionalProperties: false } }] }
    }, {
      'main.ts': `import type { PluginContext } from '@quirky/protocol'
let evidence: unknown
export async function activate(context: PluginContext): Promise<void> {
  context.provide('method:${ownerId}/evidence', () => evidence)
  evidence = await context.call('quirky.checks/run', {
    checkId: 'startup-owned',
    command: 'printf startup-check-ran',
    cwd: ${JSON.stringify(home)},
    timeoutSeconds: 5
  })
}
`
    })
    harness = await startHarness({ home, builtinPluginsDir: builtins })
    const client = await harness.connect()
    const plugin = (await client.call('plugin.list', {})).find((item) => item.id === ownerId)
    expect(plugin).toMatchObject({ state: 'active' })

    const evidence = await client.callAny(`${ownerId}/evidence`, {})
    expect(evidence).toMatchObject({ ran: true, pass: true, stdoutTail: 'startup-check-ran' })
  } finally {
    try {
      await harness?.cleanup()
    } finally {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
      if (oldQuirkyHome === undefined) delete process.env.QUIRKY_HOME
      else process.env.QUIRKY_HOME = oldQuirkyHome
      rmSync(home, { recursive: true, force: true })
    }
  }
}, 20_000)
