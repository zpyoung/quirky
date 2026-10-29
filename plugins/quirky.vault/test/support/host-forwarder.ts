import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN_ID = 'test.vault-forwarder'
const METHODS = ['list', 'search', 'searchStatus', 'setSearchEnabled'] as const

/** Writes an installable host-contribution plugin that forwards through an authenticated Quirky client. */
export function createVaultHostForwarder(remoteUrl: string): { root: string; directory: string } {
  const root = mkdtempSync(join(tmpdir(), 'qv-host-plugin-'))
  const directory = join(root, PLUGIN_ID)
  mkdirSync(directory)
  const repository = resolve(import.meta.dir, '../../../../')
  const clientModule = pathToFileURL(join(repository, 'packages', 'protocol', 'src', 'client.ts')).href

  writeFileSync(join(directory, 'quirky-plugin.json'), JSON.stringify({
    id: PLUGIN_ID,
    apiVersion: '1.0.0',
    name: 'Vault Host Forwarder Test Plugin',
    version: '1.0.0',
    main: 'main.ts',
    activation: 'lazy',
    contributes: {
      'vault-host': [{ id: 'remote', label: 'Remote fixture', methodPrefix: PLUGIN_ID }],
      method: METHODS.map((id) => ({
        id,
        params: { type: 'object', additionalProperties: true },
        result: { type: 'object', additionalProperties: true }
      }))
    }
  }, null, 2))

  writeFileSync(join(directory, 'main.ts'), [
    `import { QuirkyClient } from ${JSON.stringify(clientModule)}`,
    `const remoteUrl = ${JSON.stringify(remoteUrl)}`,
    'let remote: InstanceType<typeof QuirkyClient> | undefined',
    'export async function activate(context: { provide(id: string, handler: (params: Record<string, unknown>) => unknown): void }) {',
    "  remote = await QuirkyClient.connect(remoteUrl, { role: 'cli', name: 'test vault host forwarder' })",
    `  for (const name of ${JSON.stringify(METHODS)}) {`,
    `    context.provide(\`method:${PLUGIN_ID}/\${name}\`, (params) => remote!.callAny(\`quirky.vault/\${name}\`, params))`,
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

export function removeVaultHostForwarder(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
