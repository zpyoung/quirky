import { accessSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { constants } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { fault } from './errors'
import type { BrowserChild, BrowserDependencies } from './dependencies'
import { stopOwned } from './process'

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
      stderr: 'ignore',
      detached: true
    })
  } catch {
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
    throw fault('browser_unavailable', 'owned headless Chrome failed to start; install Chrome or set QUIRKY_BROWSER_CHROME to its executable path')
  }
}
