import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { startHarness, type Harness } from '../../../../packages/daemon/test/helpers'
import { writeEveryAgentFixture } from '../fixtures/scanner-fixtures'

const SOURCE_HOME_ENV = 'QUIRKY_VAULT_SOURCE_HOME'
const PLUGIN_IDS = ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.vault', 'quirky.ask', 'quirky.cli']
const PLUGINS_ROOT = join(import.meta.dir, '..', '..', '..')

export type FixtureExpectation = {
  expected: Record<string, { sessionId: string; title: string; cwd: string | null }>
  paths: { claude?: string }
}

export class VaultRig {
  private constructor(
    public h: Harness,
    public client: QuirkyClient,
    public events: QuirkyEvent[],
    public readonly home: string,
    public readonly sourceHome: string,
    public readonly expected: FixtureExpectation['expected'],
    public readonly fixturePaths: FixtureExpectation['paths'],
    private readonly builtinPluginsDir: string,
    private readonly previousSourceHome: string | undefined
  ) {}

  static async start(options: { isolateVaultModule?: boolean } = {}): Promise<VaultRig> {
    const home = mkdtempSync(join(tmpdir(), 'qv-home-'))
    let sourceHome: string | undefined
    const previousSourceHome = process.env[SOURCE_HOME_ENV]
    let harness: Harness | undefined
    try {
      const fixtureSourceHome = mkdtempSync(join(tmpdir(), 'qv-source-'))
      sourceHome = fixtureSourceHome
      process.env[SOURCE_HOME_ENV] = fixtureSourceHome
      const fixture = await writeEveryAgentFixture(fixtureSourceHome, { cwdRoot: join(fixtureSourceHome, 'workspaces') })
      const builtinPluginsDir = join(home, 'builtins')
      mkdirSync(builtinPluginsDir, { recursive: true })
      for (const id of PLUGIN_IDS) {
        const pluginDir = join(PLUGINS_ROOT, id)
        if (options.isolateVaultModule && id === 'quirky.vault') {
          cpSync(pluginDir, join(builtinPluginsDir, id), { recursive: true })
          symlinkSync(join(PLUGINS_ROOT, '..', 'node_modules'), join(builtinPluginsDir, id, 'node_modules'), 'dir')
        } else {
          symlinkSync(pluginDir, join(builtinPluginsDir, id), 'dir')
        }
      }
      harness = await startHarness({ home, builtinPluginsDir })
      const connected = await harness.connectWithEvents('cli')
      return new VaultRig(harness, connected.client, connected.events, home, fixtureSourceHome, fixture.expected, fixture.paths, builtinPluginsDir, previousSourceHome)
    } catch (error) {
      const cleanupErrors: unknown[] = []
      try {
        await harness?.cleanup()
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
      try {
        rmSync(home, { recursive: true, force: true })
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
      if (sourceHome !== undefined) {
        try {
          rmSync(sourceHome, { recursive: true, force: true })
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (previousSourceHome === undefined) delete process.env[SOURCE_HOME_ENV]
      else process.env[SOURCE_HOME_ENV] = previousSourceHome
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'VaultRig startup failed and cleanup was incomplete', { cause: error })
      }
      throw error
    }
  }

  searchDatabaseExists(): boolean {
    return existsSync(join(this.home, 'plugin-data', 'quirky.vault', 'session-search.sqlite'))
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.client.callAny(`quirky.vault/${method}`, params)) as T
  }

  async restart(): Promise<void> {
    for (const client of this.h.clients) client.close()
    await this.h.daemon.stop()
    this.h.pty.stop()
    this.h = await startHarness({ home: this.home, builtinPluginsDir: this.builtinPluginsDir })
    const connected = await this.h.connectWithEvents('cli')
    this.client = connected.client
    this.events = connected.events
  }

  async cleanup(): Promise<void> {
    let failed = false
    let firstError: unknown
    const attempt = async (action: () => void | Promise<void>) => {
      try {
        await action()
      } catch (error) {
        if (!failed) firstError = error
        failed = true
      }
    }
    await attempt(() => this.h.cleanup())
    await attempt(() => rmSync(this.home, { recursive: true, force: true }))
    await attempt(() => rmSync(this.sourceHome, { recursive: true, force: true }))
    await attempt(() => {
      if (this.previousSourceHome === undefined) delete process.env[SOURCE_HOME_ENV]
      else process.env[SOURCE_HOME_ENV] = this.previousSourceHome
    })
    if (failed) throw firstError
  }
}
