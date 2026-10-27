import { randomUUID } from 'node:crypto'
import { access, chmod, lstat, mkdir, open, readFile, realpath, readdir, rename, unlink } from 'node:fs/promises'
import { delimiter, dirname, join, parse } from 'node:path'
import type { ProviderRuntime } from './process'
import { homeDirectory } from './credentials'
import { record } from './provider-utils'

const OAUTH2_PARTS = ['dist', 'src', 'code_assist', 'oauth2.js']
const OAUTH_REFRESH_URL = 'https://oauth2.googleapis.com/token'
const MAX_PACKAGE_ASCENTS = 8
const MAX_OAUTH_SOURCE_BYTES = 20 * 1024 * 1024

type OAuthClient = { clientId: string; clientSecret: string }
type GeminiCredentialFile = Record<string, unknown> & { access_token: string; refresh_token: string; expiry_date: number }

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findGeminiBinary(): Promise<string | null> {
  const executable = process.platform === 'win32' ? 'gemini.cmd' : 'gemini'
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, executable)
    if (await exists(candidate)) return candidate
    if (process.platform === 'win32') {
      const plain = join(directory, 'gemini.exe')
      if (await exists(plain)) return plain
    }
  }
  if (process.platform !== 'win32') {
    for (const candidate of [
      '/usr/local/bin/gemini',
      '/opt/homebrew/bin/gemini',
      join(homeDirectory(), '.local', 'bin', 'gemini'),
      join(homeDirectory(), 'bin', 'gemini')
    ]) {
      if (await exists(candidate)) return candidate
    }
  }
  return null
}

function parseClient(text: string): OAuthClient | null {
  const clientId = text.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/)?.[1]
  const clientSecret = text.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/)?.[1]
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

async function credentialsInFile(path: string): Promise<OAuthClient | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_OAUTH_SOURCE_BYTES) return null
    return parseClient(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function oauthPath(...parts: string[]): string {
  return join(...parts, ...OAUTH2_PARTS)
}

async function fromKnownPaths(binary: string): Promise<OAuthClient | null> {
  const binDir = dirname(binary)
  const base = dirname(binDir)
  const candidates = [
    oauthPath(base, 'libexec', 'lib', 'node_modules', '@google', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core'),
    oauthPath(base, 'lib', 'node_modules', '@google', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core'),
    oauthPath(base, 'share', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core'),
    oauthPath(base, '..', 'gemini-cli-core'),
    oauthPath(base, 'node_modules', '@google', 'gemini-cli-core')
  ]
  for (const candidate of candidates) {
    const client = await credentialsInFile(candidate)
    if (client) return client
  }
  return null
}

async function findPackageRoot(binary: string): Promise<string | null> {
  let current = dirname(binary)
  for (let ascent = 0; ascent <= MAX_PACKAGE_ASCENTS; ascent += 1) {
    const packageFile = join(current, 'package.json')
    try {
      const info = await lstat(packageFile)
      if (info.isFile() && info.size <= 1024 * 1024) {
        const parsed = record(JSON.parse(await readFile(packageFile, 'utf8')) as unknown)
        if (parsed?.name === '@google/gemini-cli') return current
      }
    } catch {
      // Continue up the install tree; package metadata is not authentication state.
    }
    const globalRoots = [
      join(current, 'lib', 'node_modules', '@google', 'gemini-cli'),
      join(current, 'node_modules', '@google', 'gemini-cli')
    ]
    for (const root of globalRoots) {
      if (await exists(join(root, 'package.json'))) return root
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

async function fromBundle(packageRoot: string): Promise<OAuthClient | null> {
  const bundle = join(packageRoot, 'bundle')
  let entries: string[]
  try {
    entries = (await readdir(bundle)).filter((file) => file.endsWith('.js'))
  } catch {
    return null
  }
  for (const entry of entries) {
    const client = await credentialsInFile(join(bundle, entry))
    if (client) return client
  }
  return null
}

async function extractOAuthClient(): Promise<OAuthClient | null> {
  const binary = await findGeminiBinary()
  if (!binary) return null
  let realBinary = binary
  try {
    realBinary = await realpath(binary)
  } catch {
    // Keep the resolved PATH candidate if it is a non-symlink executable.
  }
  const known = await fromKnownPaths(realBinary)
  if (known) return known
  const packageRoot = await findPackageRoot(realBinary)
  if (!packageRoot) return null
  const source = await credentialsInFile(oauthPath(packageRoot, 'node_modules', '@google', 'gemini-cli-core')) ??
    await credentialsInFile(oauthPath(packageRoot))
  return source ?? await fromBundle(packageRoot)
}

function isCredentialFile(value: unknown): value is GeminiCredentialFile {
  const data = record(value)
  return Boolean(data && typeof data.access_token === 'string' && typeof data.refresh_token === 'string' && typeof data.expiry_date === 'number')
}

async function saveCredentials(path: string, credentials: GeminiCredentialFile): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const current = await lstat(path)
  if (!current.isFile() || current.isSymbolicLink()) throw new Error('Gemini credentials are not a regular file')
  const temporary = join(directory, `.${parse(path).base}.${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(credentials, null, 2))
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await rename(temporary, path)
    await chmod(path, 0o600)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function refreshGeminiAccessToken(
  path: string,
  raw: unknown,
  runtime: ProviderRuntime
): Promise<string | null> {
  if (!isCredentialFile(raw)) return null
  const client = await extractOAuthClient()
  if (!client) return null
  const response = await runtime.fetch(OAUTH_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: raw.refresh_token,
      grant_type: 'refresh_token'
    }).toString()
  })
  if (!response.ok) return null
  const body = record(await response.json().catch(() => null))
  const token = typeof body?.access_token === 'string' ? body.access_token : ''
  if (!token) return null
  const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : 0
  const rotated = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : raw.refresh_token
  const refreshed = { ...raw, access_token: token, refresh_token: rotated, expiry_date: runtime.now() + expiresIn * 1000 }
  await saveCredentials(path, refreshed)
  return token
}
