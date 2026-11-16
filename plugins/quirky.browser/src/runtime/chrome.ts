import { accessSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { constants } from 'node:fs'
import { dirname, join, isAbsolute, relative, resolve, sep } from 'node:path'
import { fault } from './errors'
import type { BrowserChild, BrowserDependencies } from './dependencies'
import { stopOwned } from './process'
import { createChromeProcessAccess, type ChromeProcessAccess, type ChromeProcessIdentity } from './chrome-processes'

function profileInUse(): Error {
  return fault('browser_unavailable', 'the owned browser profile is in use; its process could not be safely reclaimed')
}

/** Resolves filesystem aliases without losing literal POSIX filename bytes. */
function canonicalPath(path: string): string {
  if (!isAbsolute(path)) throw profileInUse()
  const pending = path.split('/').reverse()
  let directory = '/'
  let links = 0
  while (pending.length > 0) {
    const part = pending.pop()!
    if (!part || part === '.') continue
    if (part === '..') {
      directory = dirname(directory)
      continue
    }
    const candidate = join(directory, part)
    const entry = lstatSync(candidate)
    if (entry.isSymbolicLink()) {
      if (++links > 40) throw profileInUse()
      const target = readlinkSync(candidate)
      if (isAbsolute(target)) directory = '/'
      pending.push(...target.split('/').reverse())
    } else {
      if (pending.length > 0 && !entry.isDirectory()) throw profileInUse()
      directory = candidate
    }
  }
  return directory
}

function canonicalDirectory(path: string): string | null {
  try {
    return canonicalPath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return null
  }
}

function validateProfileDirectory(profileRoot: string, userDataDir: string): string {
  const root = canonicalPath(profileRoot)
  let directory = resolve(userDataDir)
  try {
    lstatSync(userDataDir)
    directory = canonicalPath(userDataDir)
    if (!statSync(directory).isDirectory()) throw profileInUse()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // a dangling symlink is not permission to create its target
    try { lstatSync(userDataDir); throw profileInUse() } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError
    }
    directory = join(root, 'chrome-profile')
  }
  const child = relative(root, directory)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw profileInUse()
  return directory
}

function optionValues(argv: readonly string[], name: string, takesValue = true): string[] {
  const values: string[] = []
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!
    if (argument === '--') break
    if (argument === name) values.push(takesValue ? argv[index + 1] ?? '' : '')
    else if (argument.startsWith(`${name}=`)) values.push(argument.slice(name.length + 1))
  }
  return values
}

function selectsDirectory(identity: ChromeProcessIdentity, directory: string): boolean {
  if (!identity || !Array.isArray(identity.argv) || identity.argv.some(argument => typeof argument !== 'string')) throw profileInUse()
  return optionValues(identity.argv, '--user-data-dir').some(path => {
    if (!isAbsolute(path)) return false
    const actual = canonicalDirectory(path)
    if (actual === null && resolve(path) === directory) throw profileInUse()
    return actual === directory
  })
}

function isOwnedOrphan(identity: ChromeProcessIdentity, directory: string, executablePath: string): boolean {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 1 || identity.ppid !== 1 ||
    identity.uid !== process.getuid?.() || identity.pgid !== identity.pid ||
    typeof identity.started !== 'string' || !identity.started ||
    !isAbsolute(identity.executable) || canonicalPath(identity.executable) !== canonicalPath(executablePath)) return false
  const argv = identity.argv
  const headless = optionValues(argv, '--headless', false)
  const addresses = optionValues(argv, '--remote-debugging-address')
  const ports = optionValues(argv, '--remote-debugging-port')
  return optionValues(argv, '--user-data-dir').length === 1 && selectsDirectory(identity, directory) &&
    headless.length === 1 && (headless[0] === 'new' || headless[0] === '') &&
    addresses.length === 1 && addresses[0] === '127.0.0.1' && ports.length === 1 && ports[0] === '0' &&
    optionValues(argv, '--type').length === 0 && optionValues(argv, '--remote-debugging-pipe', false).length === 0
}

function sameIdentity(expected: ChromeProcessIdentity, actual: ChromeProcessIdentity): boolean {
  return expected.pid === actual.pid && expected.started === actual.started &&
    expected.ppid === actual.ppid && expected.pgid === actual.pgid && expected.uid === actual.uid &&
    expected.executable === actual.executable && expected.argv.length === actual.argv.length &&
    expected.argv.every((argument, index) => argument === actual.argv[index])
}

async function inspectUnchanged(access: ChromeProcessAccess, identity: ChromeProcessIdentity): Promise<boolean> {
  const current = await access.inspect(identity.pid)
  if (current === null) return false
  if (!sameIdentity(identity, current)) throw profileInUse()
  return true
}

async function waitForDisappearance(access: ChromeProcessAccess, identity: ChromeProcessIdentity, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds
  while (true) {
    if (!await inspectUnchanged(access, identity)) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    const waiting = Promise.withResolvers<void>()
    setTimeout(waiting.resolve, Math.min(25, remaining))
    await waiting.promise
  }
}

async function reclaimProfile(directory: string, executablePath: string, dependencies: BrowserDependencies): Promise<void> {
  const access = dependencies.chromeProcesses ?? createChromeProcessAccess(dependencies.process, {
    executablePath,
    resolvedExecutablePath: canonicalPath(executablePath)
  })
  const holders = (await access.snapshot()).filter(identity => selectsDirectory(identity, directory))
  if (holders.some(identity => !isOwnedOrphan(identity, directory, executablePath))) throw profileInUse()
  const remaining: ChromeProcessIdentity[] = []
  for (const identity of holders) {
    if (await inspectUnchanged(access, identity)) remaining.push(identity)
  }
  for (const identity of remaining) {
    if (!await inspectUnchanged(access, identity)) continue
    try { access.signal(identity.pid, 'SIGTERM') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    if (await waitForDisappearance(access, identity, 5_000)) continue
    if (!await inspectUnchanged(access, identity)) continue
    try { access.signal(identity.pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    if (!await waitForDisappearance(access, identity, 1_000)) throw profileInUse()
  }
}

export type OwnedChrome = {
  child: BrowserChild
  cdpUrl: string
  browserWebSocketUrl: string
  profileRoot: string
  asyncClose(): Promise<void>
}

function cleanEnvironment(home: string): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string' || key.startsWith('AGENT_BROWSER_') || key.startsWith('QUIRKY_BROWSER_')) continue
    clean[key] = value
  }
  return Object.assign(clean, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    QUIRKY_HOME: home
  })
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

function findChrome(dependencies: BrowserDependencies): string {
  if (dependencies.chromePath !== undefined) {
    if (dependencies.chromePath === null) return findDefaultChrome()
    if (!isAbsolute(dependencies.chromePath) || !existsSync(dependencies.chromePath) || !executable(dependencies.chromePath)) {
      throw fault('browser_unavailable', 'QUIRKY_BROWSER_CHROME must name an absolute executable Chrome or Chromium binary; install Chrome or set that variable to its executable path')
    }
    return dependencies.chromePath
  }
  const configured = process.env.QUIRKY_BROWSER_CHROME
  if (configured !== undefined) {
    if (!isAbsolute(configured) || !existsSync(configured) || !executable(configured)) {
      throw fault('browser_unavailable', 'QUIRKY_BROWSER_CHROME must name an absolute executable Chrome or Chromium binary; install Chrome or set that variable to its executable path')
    }
    return configured
  }
  return findDefaultChrome()
}

function findDefaultChrome(): string {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]
  const found = candidates.find((path) => existsSync(path) && executable(path))
  if (!found) throw fault('browser_unavailable', 'no Chrome or Chromium executable was found; install Chrome or set QUIRKY_BROWSER_CHROME to its absolute executable path')
  return found
}

async function waitForDevTools(child: BrowserChild, userDataDir: string): Promise<{ cdpUrl: string; browserWebSocketUrl: string }> {
  const marker = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(0).then(() => false)])
    if (exited) throw new Error('Chrome exited before opening its private debugging port')
    if (existsSync(marker)) {
      try {
        const [portText, webSocketPath] = readFileSync(marker, 'utf8').trim().split(/\r?\n/)
        const port = Number(portText)
        if (Number.isInteger(port) && port > 0 && port < 65_536 && webSocketPath?.startsWith('/devtools/browser/')) {
          const exitedAfterRead = await Promise.race([child.exited.then(() => true), Bun.sleep(0).then(() => false)])
          if (exitedAfterRead) throw new Error('Chrome exited after publishing its private debugging endpoint')
          return { cdpUrl: `http://127.0.0.1:${port}`, browserWebSocketUrl: `ws://127.0.0.1:${port}${webSocketPath}` }
        }
      } catch {
        // Chrome may be writing DevToolsActivePort; retry until the bounded startup deadline.
      }
    }
    await Bun.sleep(25)
  }
  throw new Error('Chrome did not publish its private debugging endpoint before timeout')
}

export async function startChrome(
  profileRoot: string,
  dependencies: BrowserDependencies
): Promise<OwnedChrome> {
  const executablePath = findChrome(dependencies)
  const userDataDir = join(profileRoot, 'chrome-profile')
  const home = join(profileRoot, 'chrome-home')
  try {
    const directory = validateProfileDirectory(profileRoot, userDataDir)
    await reclaimProfile(directory, executablePath, dependencies)
  } catch {
    throw profileInUse()
  }
  rmSync(join(userDataDir, 'DevToolsActivePort'), { force: true })
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(join(home, '.config'), { recursive: true, mode: 0o700 })
  chmodSync(profileRoot, 0o700)
  chmodSync(userDataDir, 0o700)
  chmodSync(home, 0o700)
  const args = [
    '--headless=new',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-default-apps',
    // the private HOME hides the login keychain, so macOS would prompt to create one on every launch
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ...(dependencies.chromeArguments ?? []),
    'about:blank'
  ]
  let child: BrowserChild
  try {
    child = dependencies.spawn([executablePath, ...args], {
      cwd: profileRoot,
      env: cleanEnvironment(home),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    })
  } catch {
    throw fault('browser_unavailable', 'the configured Chrome executable could not be started')
  }
  if (child.pid === null) {
    throw fault('browser_unavailable', 'the configured Chrome executable could not be started')
  }
  try {
    const endpoint = await waitForDevTools(child, userDataDir)
    return {
      child,
      ...endpoint,
      profileRoot,
      async asyncClose() { await stopOwned(child, 5_000) }
    }
  } catch {
    await stopOwned(child, 500)
    throw fault('browser_unavailable', 'owned headless Chrome failed to start; the profile may be in use or Chrome could not open its private debugging port')
  }
}
