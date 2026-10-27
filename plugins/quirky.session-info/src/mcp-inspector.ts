import { join } from 'node:path'
import { BoundedConfigReadError, readBoundedConfig } from './bounded-read'
import { isRecord } from './json'

export type McpTransport = 'stdio' | 'http' | 'sse' | 'invalid'
export type McpServerState = 'enabled' | 'disabled' | 'invalid'

export type McpInspectionResult = {
  servers: Array<{ name: string; transport: McpTransport; state: McpServerState }>
  errors: string[]
}

type ConfigScope = { path: string; label: string; workspaceJson: boolean }
type DiscoveredServer = { name: string; transport: McpTransport; workspaceJson: boolean }


function transportOf(value: unknown): McpTransport {
  if (!isRecord(value)) return 'invalid'

  if (value.type === 'http' || value.type === 'sse') {
    return typeof value.url === 'string' && value.url.trim().length > 0 ? value.type : 'invalid'
  }

  if (value.type !== undefined && value.type !== 'stdio') return 'invalid'
  return typeof value.command === 'string' && value.command.trim().length > 0 ? 'stdio' : 'invalid'
}

function addConfiguredNames(
  value: unknown,
  names: Set<string>,
  markInvalid: () => void
): void {
  if (!Array.isArray(value)) {
    markInvalid()
    return
  }

  for (const name of value) {
    if (typeof name === 'string') names.add(name)
    else markInvalid()
  }
}
function stateOf(
  name: string,
  transport: McpTransport,
  enabledNames: Set<string>,
  disabledNames: Set<string>,
  enabledListSpecified: boolean,
  workspaceJson: boolean
): McpServerState {
  if (transport === 'invalid') return 'invalid'
  if (disabledNames.has(name)) return 'disabled'
  if (enabledNames.has(name)) return 'enabled'
  if (workspaceJson && enabledListSpecified) return 'disabled'
  return 'enabled'
}


export async function inspectMcp({ cwd, configDir }: { cwd: string; configDir: string }): Promise<McpInspectionResult> {
  const scopes: ConfigScope[] = [
    { path: join(cwd, '.mcp.json'), label: 'workspace MCP config', workspaceJson: true },
    { path: join(cwd, '.claude', 'settings.json'), label: 'workspace settings', workspaceJson: false },
    { path: join(cwd, '.claude', 'settings.local.json'), label: 'workspace local settings', workspaceJson: false },
    { path: join(configDir, 'settings.json'), label: 'user settings', workspaceJson: false }
  ]
  const discovered: DiscoveredServer[] = []
  const seenServers = new Set<string>()
  const enabledNames = new Set<string>()
  const disabledNames = new Set<string>()
  let enabledListSpecified = false
  const errors: string[] = []

  for (const scope of scopes) {
    let contents: string
    try {
      contents = (await readBoundedConfig(scope.path)).toString('utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push(
          error instanceof BoundedConfigReadError
            ? `Could not read ${scope.label}: ${error.message}`
            : `Could not read ${scope.label}`
        )
      }
      continue
    }

    let config: unknown
    try {
      config = JSON.parse(contents)
    } catch {
      errors.push(`Malformed JSON in ${scope.label}`)
      continue
    }
    if (!isRecord(config)) {
      errors.push(`Invalid MCP config in ${scope.label}`)
      continue
    }

    let invalidConfig = false
    const markInvalid = () => { invalidConfig = true }
    if (Object.hasOwn(config, 'enabledMcpjsonServers')) {
      enabledListSpecified = true
      addConfiguredNames(config.enabledMcpjsonServers, enabledNames, markInvalid)
    }
    if (Object.hasOwn(config, 'disabledMcpServers')) {
      addConfiguredNames(config.disabledMcpServers, disabledNames, markInvalid)
    }

    if (Object.hasOwn(config, 'mcpServers')) {
      const configuredServers = config.mcpServers
      if (!isRecord(configuredServers)) {
        markInvalid()
      } else {
        for (const [name, definition] of Object.entries(configuredServers)) {
          if (seenServers.has(name)) continue
          seenServers.add(name)
          discovered.push({ name, transport: transportOf(definition), workspaceJson: scope.workspaceJson })
        }
      }
    }

    if (invalidConfig) errors.push(`Invalid MCP config in ${scope.label}`)
  }

  const servers = discovered.map(({ name, transport, workspaceJson }) => ({
    name,
    transport,
    state: stateOf(name, transport, enabledNames, disabledNames, enabledListSpecified, workspaceJson)
  }))


  return { servers, errors }
}
