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
  onOperation?: (event: BrowserOperationEvent) => void
  onControl?: (control: BrowserTestControl) => void
}
