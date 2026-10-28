import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const METHODS = ['list', 'search', 'searchStatus', 'setSearchEnabled'] as const

type HostPluginOptions = { pluginId: string; label: string; remoteUrl: string }

export function createWindowVaultHostForwarder(options: HostPluginOptions): { root: string; directory: string } {
  const root = mkdtempSync(join(tmpdir(), 'qv-window-host-'))
  const directory = join(root, options.pluginId)
  mkdirSync(directory)
  const repository = join(import.meta.dir, '../../..')
  const clientModule = pathToFileURL(join(repository, 'packages', 'protocol', 'src', 'client.ts')).href
  writeFileSync(join(directory, 'quirky-plugin.json'), JSON.stringify({
    id: options.pluginId,
    name: 'Vault Window Host Fixture',
    version: '1.0.0',
    main: 'main.ts',
    activation: 'lazy',
    contributes: {
      'vault-host': [{ id: 'remote', label: options.label, methodPrefix: options.pluginId }],
      method: METHODS.map((id) => ({
        id,
        params: { type: 'object', additionalProperties: true },
        result: { type: 'object', additionalProperties: true }
      }))
    }
  }, null, 2))
  writeFileSync(join(directory, 'main.ts'), [
    `import { QuirkyClient } from ${JSON.stringify(clientModule)}`,
    `const remoteUrl = ${JSON.stringify(options.remoteUrl)}`,
    `const pluginId = ${JSON.stringify(options.pluginId)}`,
    'let remote: InstanceType<typeof QuirkyClient> | undefined',
    'export async function activate(context: { provide(id: string, handler: (params: Record<string, unknown>) => unknown): void }) {',
    "  remote = await QuirkyClient.connect(remoteUrl, { role: 'cli', name: 'vault window host fixture' })",
    `  for (const name of ${JSON.stringify(METHODS)}) {`,
    '    context.provide(`method:${pluginId}/${name}`, (params) => remote!.callAny(`quirky.vault/${name}`, params))',
    '  }',
    '}',
    'export async function deactivate() {',
    '  const client = remote',
    '  remote = undefined',
    '  client?.close()',
    '}'
  ].join('\n'))
  return { root, directory }
}

export function removeWindowVaultHostForwarder(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
