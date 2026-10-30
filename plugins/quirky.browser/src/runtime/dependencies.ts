import type { BrowserFamily, Cookie } from '../cookies/types'

export type CookieTransport = {
  list(profileId: string): Promise<Cookie[]>
  delete(profileId: string, cookie: Cookie): Promise<void>
  set(profileId: string, cookie: Cookie): Promise<void>
}
export type BrowserDialogEvent = { pageId: string; type: string }

export type BrowserSpawnOptions = {
  cwd: string
  env: Record<string, string>
  stdin: 'ignore'
  stdout: 'ignore'
  stderr: 'ignore'
  detached?: boolean
}

export type BrowserChild = Bun.Subprocess<'ignore', 'ignore', 'ignore'>
export type BrowserSpawn = (command: string[], options: BrowserSpawnOptions) => BrowserChild
export type BrowserOperationEvent = { pageId: string; method: string }
export type BrowserTestControl = { crashHelper(profileId: string): Promise<void> }

export type BrowserDependencies = {
  runtimeRoot: string
  spawn: BrowserSpawn
  chromeArguments?: string[]
  chromePath?: string | null
  sourceRoots?: Partial<Record<BrowserFamily, string>>
  keyProvider?: (family: BrowserFamily) => Promise<Buffer | null>
  wrapCookieTransport?: (transport: CookieTransport) => CookieTransport
  onDialog?: (event: BrowserDialogEvent) => void
  onOperation?: (event: BrowserOperationEvent) => void
  onControl?: (control: BrowserTestControl) => void
  /** Overrides the OS destination only for isolated runtime consumers/tests. */
  downloadDirectory?: string
  /** Shortens the page-prompt deadline only for tests of its fail-closed path. */
  promptTimeoutMs?: number
}
