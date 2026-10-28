import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { startHarness, type Harness } from '../../../../packages/daemon/test/helpers'
import { writeEveryAgentFixture } from '../fixtures/scanner-fixtures'

const SOURCE_HOME_ENV = 'QUIRKY_VAULT_SOURCE_HOME'
const PLUGIN_IDS = [
  'quirky.repo',
  'quirky.cli',
  'quirky.worktree',
  'quirky.agents',
  'quirky.session',
  'quirky.terminal',
  'quirky.vault',
  'quirky.ask'
]
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

  static async start(options: { isolateVaultPlugin?: boolean } = {}): Promise<VaultRig> {
    const home = mkdtempSync(join(tmpdir(), 'qv-home-'))
    const sourceHome = mkdtempSync(join(tmpdir(), 'qv-source-'))
    const previousSourceHome = process.env[SOURCE_HOME_ENV]
    process.env[SOURCE_HOME_ENV] = sourceHome
    const fixture = await writeEveryAgentFixture(sourceHome, { cwdRoot: join(sourceHome, 'workspaces') })
    const builtinPluginsDir = join(home, 'builtins')
    mkdirSync(builtinPluginsDir, { recursive: true })
    for (const id of PLUGIN_IDS) {
      const source = join(PLUGINS_ROOT, id)
      if (options.isolateVaultPlugin && id === 'quirky.vault') {
        // In-process daemons share Bun's module cache; isolate the plugin's module-level service.
        cpSync(source, join(builtinPluginsDir, id), { recursive: true })
      } else {
        symlinkSync(source, join(builtinPluginsDir, id), 'dir')
      }
    }
    const h = await startHarness({ home, builtinPluginsDir })
    const connected = await h.connectWithEvents('cli')
    return new VaultRig(h, connected.client, connected.events, home, sourceHome, fixture.expected, fixture.paths, builtinPluginsDir, previousSourceHome)
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
    for (const client of this.h.clients) client.close()
    await this.h.daemon.stop()
    this.h.pty.stop()
    rmSync(this.home, { recursive: true, force: true })
    rmSync(this.sourceHome, { recursive: true, force: true })
    if (this.previousSourceHome === undefined) delete process.env[SOURCE_HOME_ENV]
    else process.env[SOURCE_HOME_ENV] = this.previousSourceHome
  }
}
