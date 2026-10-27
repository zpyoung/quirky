export type AuthAccount = {
  host: string
  user: string
  source: 'keyring' | 'env'
  active: boolean
  scopes: string[]
}

const ENV_TOKEN_SOURCES = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])

export function parseAuthInventory(output: string): AuthAccount[] {
  const sections = output.split(/(?=^Logged in to )/m).filter((section) => /^Logged in to /m.test(section))
  const accounts: AuthAccount[] = []
  for (const section of sections) {
    const header = /^Logged in to\s+(\S+)\s+account\s+(\S+)\s+\(([^)]+)\)/m.exec(section)
    if (!header) continue
    const host = normalizeHost(header[1] ?? '')
    const user = header[2] ?? ''
    if (!isHost(host) || !isLogin(user)) continue
    const sourceLabel = (header[3] ?? '').trim()
    const scopesLine = /^Token scopes:\s*(.*?)\s*$/m.exec(section)?.[1] ?? ''
    const scopes = scopesLine
      .split(/[\s,]+/)
      .map((scope) => scope.replace(/^['"]|['"]$/g, '').trim())
      .filter((scope) => scope.length > 0)
    accounts.push({
      host,
      user,
      source: ENV_TOKEN_SOURCES.has(sourceLabel) ? 'env' : 'keyring',
      active: /^Active account:\s*true\s*$/m.test(section),
      scopes
    })
  }
  return accounts
}

export function matchEnterpriseHost(
  remoteHost: string,
  sshRemote: boolean,
  accounts: readonly AuthAccount[]
): string | null {
  const normalized = normalizeHost(remoteHost)
  if (normalized === 'github.com') return 'github.com'
  if (normalized.includes(':')) return accounts.some((account) => account.host === normalized) ? normalized : null
  const exact = new Set(accounts.filter((account) => account.host === normalized).map((account) => account.host))
  if (exact.size === 1) return normalized
  if (!sshRemote) return null
  const withPort = new Set(accounts.filter((account) => hostnameOf(account.host) === normalized).map((account) => account.host))
  return withPort.size === 1 ? withPort.values().next().value ?? null : null
}

export function normalizeHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, '')
  return host === 'ssh.github.com' ? 'github.com' : host
}

export function isHost(value: string): boolean {
  if (value.length === 0 || value.length > 255 || /[\s/@?#\\]/.test(value)) return false
  const hostAndPort = /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.test(value)
  if (!hostAndPort || value === '.' || value === '..') return false
  const port = value.slice(value.lastIndexOf(':') + 1)
  return !value.includes(':') || (Number(port) > 0 && Number(port) <= 65535)
}

function hostnameOf(host: string): string {
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'))
  return host.replace(/:\d+$/, '')
}

function isLogin(value: string): boolean {
  return value.length > 0 && value.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)
}
