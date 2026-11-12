import type { ProcessSpawner } from '@quirky/process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writePrivateJson } from '@quirky/protocol/node'
import { bashRcfilePath, inheritedEnv, shellKind } from './launch'
import { kernelProcess } from './kernel-process'

/** How long one read of the interactive shell may run before it is stopped. */
const PROBE_TIMEOUT_MS = 15_000
/** A PATH older than this is read again, in the background, the next time a command launches. */
const MAX_AGE_MS = 5 * 60_000

function probeArgv(home: string, shell: string, script: string): string[] | undefined {
  const kind = shellKind(shell)
  if (kind === 'zsh') return [shell, '-i', '-l', '-c', script]
  if (kind === 'bash') return [shell, '--rcfile', bashRcfilePath(home), '-i', '-c', script]
  return undefined
}

/**
 * Reads PATH as the user's interactive shell sets it: zsh as an interactive login shell, bash
 * through Quirky's rcfile as its terminals start. Resolves undefined for other shells, and when
 * the shell fails or does not print its PATH within `timeoutMs`. A shell still running at the
 * timeout or at `signal`, even after it printed its PATH, is killed with its process group. Output
 * from rc files is ignored, and the shell gets no terminal and an empty stdin.
 */
export function readInteractivePath(
  home: string,
  shell: string,
  env: Record<string, string | undefined>,
  options: { timeoutMs?: number; signal?: AbortSignal; spawner?: ProcessSpawner } = {}
): Promise<string | undefined> {
  const marker = `__quirky_path_${randomBytes(8).toString('hex')}__`
  const argv = probeArgv(home, shell, `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`)
  if (argv === undefined || options.signal?.aborted) return Promise.resolve(undefined)
  const { promise, resolve } = Promise.withResolvers<string | undefined>()
  let settled = false
  const settle = (path: string | undefined) => {
    if (settled) return
    settled = true
    resolve(path === '' ? undefined : path)
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    const child = (options.spawner ?? kernelProcess).spawn(argv, {
      env: inheritedEnv(env),
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      killGraceMs: 0,
      signal: options.signal
    })
    reader = child.stdout.getReader()
  } catch {
    settle(undefined)
    return promise
  }
  const decoder = new TextDecoder()
  let text = ''
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          settle(undefined)
          return
        }
        if (settled) continue
        text += decoder.decode(value, { stream: true })
        const start = text.indexOf(marker)
        const end = start < 0 ? -1 : text.indexOf(marker, start + marker.length)
        if (end >= 0) {
          settle(text.slice(start + marker.length, end))
          text = ''
        }
      }
    } catch {
      settle(undefined)
    } finally {
      try {
        reader.releaseLock()
      } catch {}
    }
  })()
  return promise
}

type Stored = { shell: string; path: string }

/**
 * The PATH of the user's interactive shell for commands launched through `commandArgv`, kept in
 * `<home>/interactive-path.json` so a restarted daemon has it before its first read finishes.
 * Reading a slow rc file can take seconds, so every read happens in the background.
 */
export class InteractivePath {
  private readonly file: string
  private path: string | undefined
  private readAt = 0
  private running: Promise<void> | undefined
  private readonly stopped = new AbortController()

  constructor(
    private readonly options: {
      home: string
      shell: string
      env?: Record<string, string | undefined>
      log?: (message: string) => void
      timeoutMs?: number
      maxAgeMs?: number
    }
  ) {
    this.file = join(options.home, 'interactive-path.json')
    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Stored>
      if (stored.shell === options.shell && typeof stored.path === 'string' && stored.path !== '') this.path = stored.path
    } catch {}
  }

  /** The last PATH read, or undefined before any read has succeeded. A stale value starts a read in the background. */
  current(): string | undefined {
    if (Date.now() - this.readAt >= (this.options.maxAgeMs ?? MAX_AGE_MS)) void this.refresh()
    return this.path
  }

  /** Reads the PATH again unless a read is already running. Never rejects; a failed read keeps the last PATH. */
  refresh(): Promise<void> {
    if (this.stopped.signal.aborted) return Promise.resolve()
    this.running ??= this.read().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  /** Kills a running read; later reads do nothing. */
  dispose(): void {
    this.stopped.abort()
  }

  private async read(): Promise<void> {
    const { home, shell, env, timeoutMs } = this.options
    const path = await readInteractivePath(home, shell, env ?? process.env, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      signal: this.stopped.signal
    })
    this.readAt = Date.now()
    if (this.stopped.signal.aborted) return
    if (path === undefined) {
      this.options.log?.(`could not read PATH from an interactive ${shell}; commands keep the login shell's PATH`)
      return
    }
    this.path = path
    try {
      writePrivateJson(this.file, { shell, path } satisfies Stored)
    } catch (error) {
      this.options.log?.(`could not save the interactive shell PATH: ${(error as Error).message}`)
    }
  }
}
