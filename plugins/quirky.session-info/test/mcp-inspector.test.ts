import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inspectMcp } from '../src/mcp-inspector'

type Fixture = { root: string; cwd: string; configDir: string }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'quirky-mcp-inspector-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  const configDir = join(root, 'user-config')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  return { root, cwd, configDir }
}

function writeConfig(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value), 'utf8')
}

test('inspects each known scope in precedence order and exposes only metadata', async () => {
  const fixture = makeFixture()
  const marker = join(fixture.root, 'command-ran')

  writeConfig(join(fixture.cwd, '.mcp.json'), {
    mcpServers: {
      shared: {
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        env: { TOKEN: 'stdio-secret' }
      },
      workspaceHttp: { type: 'http', url: 'https://user:password@example.test/mcp?token=secret' }
    }
  })
  writeConfig(join(fixture.cwd, '.claude', 'settings.json'), {
    mcpServers: {
      shared: { type: 'sse', url: 'https://shadowed.example.test/events' },
      workspaceSettings: { type: 'sse', url: 'https://events.example.test/sse' }
    }
  })
  writeConfig(join(fixture.cwd, '.claude', 'settings.local.json'), {
    mcpServers: { workspaceLocal: { command: 'local-command' } }
  })
  writeConfig(join(fixture.configDir, 'settings.json'), {
    disabledMcpServers: ['userSettings'],
    mcpServers: { userSettings: { command: 'user-command' } }
  })


  const result = await inspectMcp({ cwd: fixture.cwd, configDir: fixture.configDir })

  expect(result).toEqual({
    servers: [
      { name: 'shared', transport: 'stdio', state: 'enabled' },
      { name: 'workspaceHttp', transport: 'http', state: 'enabled' },
      { name: 'workspaceSettings', transport: 'sse', state: 'enabled' },
      { name: 'workspaceLocal', transport: 'stdio', state: 'enabled' },
      { name: 'userSettings', transport: 'stdio', state: 'disabled' }
    ],
    errors: []
  })
  expect(existsSync(marker)).toBe(false)
  expect(JSON.stringify(result)).not.toContain('stdio-secret')
  expect(JSON.stringify(result)).not.toContain('password')
  expect(JSON.stringify(result)).not.toContain('token=secret')
})

test('merges enabled and disabled names from workspace and user settings', async () => {
  const fixture = makeFixture()
  writeConfig(join(fixture.cwd, '.mcp.json'), {
    mcpServers: {
      workspaceEnabled: { command: 'one' },
      localEnabled: { command: 'two' },
      userDisabled: { command: 'three' },
      disabledWins: { command: 'four' },
      implicit: { command: 'five' }
    }
  })
  writeConfig(join(fixture.cwd, '.claude', 'settings.json'), {
    enabledMcpjsonServers: ['workspaceEnabled'],
    disabledMcpServers: ['userDisabled']
  })
  writeConfig(join(fixture.cwd, '.claude', 'settings.local.json'), {
    enabledMcpjsonServers: ['localEnabled'],
    disabledMcpServers: ['disabledWins']
  })
  writeConfig(join(fixture.configDir, 'settings.json'), {
    enabledMcpjsonServers: ['disabledWins'],
    disabledMcpServers: ['disabledWins']
  })

  const result = await inspectMcp({ cwd: fixture.cwd, configDir: fixture.configDir })

  expect(result.servers).toEqual([
    { name: 'workspaceEnabled', transport: 'stdio', state: 'enabled' },
    { name: 'localEnabled', transport: 'stdio', state: 'enabled' },
    { name: 'userDisabled', transport: 'stdio', state: 'disabled' },
    { name: 'disabledWins', transport: 'stdio', state: 'disabled' },
    { name: 'implicit', transport: 'stdio', state: 'disabled' },
  ])
  expect(result.errors).toEqual([])
})

test('an invalid first server entry claims its name over a later valid entry', async () => {
  const fixture = makeFixture()
  writeConfig(join(fixture.cwd, '.mcp.json'), {
    mcpServers: { broken: null, unknownTransport: { type: 'grpc', url: 'secret' } }
  })
  writeConfig(join(fixture.cwd, '.claude', 'settings.json'), {
    disabledMcpServers: ['broken'],
    mcpServers: {
      broken: { command: 'must-not-replace' },
      unknownTransport: { type: 'http', url: 'https://later.example.test' },
      validLater: { type: 'http', url: 'https://valid.example.test' }
    }
  })


  const result = await inspectMcp({ cwd: fixture.cwd, configDir: fixture.configDir })

  expect(result.servers).toEqual([
    { name: 'broken', transport: 'invalid', state: 'invalid' },
    { name: 'unknownTransport', transport: 'invalid', state: 'invalid' },
    { name: 'validLater', transport: 'http', state: 'enabled' }
  ])
  expect(JSON.stringify(result)).not.toContain('secret')
})

test('malformed and unreadable files report bounded errors without discarding other scopes', async () => {
  const fixture = makeFixture()
  const malformed = join(fixture.cwd, '.mcp.json')
  mkdirSync(dirname(malformed), { recursive: true })
  writeFileSync(malformed, '{"private":"malformed-secret"', 'utf8')
  writeConfig(join(fixture.cwd, '.claude', 'settings.json'), {
    mcpServers: { workspaceServer: { command: 'safe' } }
  })
  mkdirSync(join(fixture.cwd, '.claude', 'settings.local.json'), { recursive: true })
  writeConfig(join(fixture.configDir, 'settings.json'), {
    mcpServers: { userServer: { type: 'http', url: 'https://safe.example.test' } }
  })

  const result = await inspectMcp({ cwd: fixture.cwd, configDir: fixture.configDir })

  expect(result.servers).toEqual([
    { name: 'workspaceServer', transport: 'stdio', state: 'enabled' },
    { name: 'userServer', transport: 'http', state: 'enabled' }
  ])
  expect(result.errors).toHaveLength(2)
  expect(result.errors.join(' ')).not.toContain('malformed-secret')
  expect(result.errors.join(' ')).not.toContain('settings.local.json')
})

test('oversized workspace MCP config reports a visible error and preserves later scopes', async () => {
  const fixture = makeFixture()
  writeFileSync(join(fixture.cwd, '.mcp.json'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20))
  writeConfig(join(fixture.cwd, '.claude', 'settings.json'), {
    mcpServers: { validScope: { command: 'safe' } }
  })

  const result = await inspectMcp({ cwd: fixture.cwd, configDir: fixture.configDir })

  expect(result.servers).toEqual([{ name: 'validScope', transport: 'stdio', state: 'enabled' }])
  expect(result.errors.join(' ')).toContain('exceeds 4194304 bytes')
})
