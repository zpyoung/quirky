import type { PluginContext } from '@quirky/protocol'
import { hookCommand } from './hook-command'

const PROBE_TIMEOUT_MS = 3000
const RETRY_AFTER_FAILURE_MS = 30 * 60_000
const HOOK_TIMEOUT_SECONDS = 10

/**
 * The first Claude release whose settings schema accepts each hook event. Older releases discard the
 * whole settings file over one unknown event name, so an event is written only for a Claude that
 * knows it. Mirrors Orca's table; PreCompact is deliberately absent.
 */
export const CLAUDE_HOOK_EVENT_FIRST_VERSIONS = {
  SessionStart: '1.0.62',
  UserPromptSubmit: '1.0.53',
  Stop: '1.0.31',
  StopFailure: '2.1.78',
  SubagentStart: '2.0.43',
  SubagentStop: '1.0.41',
  TeammateIdle: '2.1.33',
  PreToolUse: '1.0.23',
  PostToolUse: '1.0.23',
  PostToolUseFailure: '2.0.56',
  PermissionRequest: '2.0.45',
  PostCompact: '2.1.76',
  SessionEnd: '2.1.261'
} as const

/** What an unresolved version is assumed to know: the first release with the core lifecycle events. */
const UNRESOLVED_CLAUDE_VERSION = '1.0.64'

const MATCHED_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'])

type Triple = [number, number, number]

function triple(text: string): Triple | null {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function reaches(version: Triple, floor: Triple): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== floor[i]!) return version[i]! > floor[i]!
  }
  return true
}

/** The first `x.y.z` in `claude --version` output (`2.1.310 (Claude Code)`), or null when there is none. */
export function parseClaudeVersion(output: string | null | undefined): string | null {
  const found = output ? triple(output) : null
  return found ? found.join('.') : null
}

/** The hook events a Claude of this version accepts; a null version gets the set 1.0.64 knows. */
export function claudeEventsFor(version: string | null): string[] {
  const known = (version === null ? null : triple(version)) ?? triple(UNRESOLVED_CLAUDE_VERSION)!
  return Object.entries(CLAUDE_HOOK_EVENT_FIRST_VERSIONS)
    .filter(([, first]) => reaches(known, triple(first)!))
    .map(([name]) => name)
}

/** The settings object passed to `claude --settings`: one Quirky command hook per event. */
export function claudeSettings(events: readonly string[]): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {}
  for (const event of events) {
    hooks[event] = [
      {
        ...(MATCHED_EVENTS.has(event) ? { matcher: '*' } : {}),
        hooks: [{ type: 'command', command: hookCommand('claude'), timeout: HOOK_TIMEOUT_SECONDS }]
      }
    ]
  }
  return { hooks }
}


/** The session a probe runs for; its environment is the one the agent would get. */
export type ProbeIdentity = { sessionId: string; worktreeId: string }

/** Runs `<command> --version` and returns its stdout, or null on any failure. */
export type VersionProbe = (command: string, identity: ProbeIdentity) => Promise<string | null>

type Verdict = { version: string | null; retryAt: number }

/**
 * Resolves the Claude version per command through a probe. A resolved version is kept for the gate's
 * life; a failure (unreadable output, probe error or timeout) is kept for 30 minutes so a broken
 * install is not probed on every launch but an upgrade is noticed. Concurrent calls for one command
 * share one probe.
 */
export class ClaudeVersionGate {
  private readonly verdicts = new Map<string, Verdict>()
  private readonly inFlight = new Map<string, Promise<string | null>>()

  constructor(
    private readonly probe: VersionProbe,
    private readonly now: () => number
  ) {}

  version(command: string, identity: ProbeIdentity = { sessionId: '', worktreeId: '' }): Promise<string | null> {
    const known = this.verdicts.get(command)
    if (known && (known.version !== null || this.now() < known.retryAt)) return Promise.resolve(known.version)
    const running = this.inFlight.get(command)
    if (running) return running
    const started = this.run(command, identity).finally(() => this.inFlight.delete(command))
    this.inFlight.set(command, started)
    return started
  }

  private async run(command: string, identity: ProbeIdentity): Promise<string | null> {
    let version: string | null = null
    try {
      version = parseClaudeVersion(await this.probe(command, identity))
    } catch {
      version = null
    }
    this.verdicts.set(command, { version, retryAt: this.now() + RETRY_AFTER_FAILURE_MS })
    return version
  }
}

function singleQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}

/** SIGKILLs the probe's whole process group (it is spawned as a group leader), else the process alone. */
function killProbe(proc: ReturnType<typeof Bun.spawn>): void {
  try {
    process.kill(-proc.pid, 'SIGKILL')
  } catch {
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

/**
 * The default probe: runs the command under the daemon's login shell with the session's launch
 * environment. After `timeoutMs` it SIGKILLs the probe's process group and returns null without
 * waiting for it or its output. Each word of the configured command is quoted, so shell syntax in
 * it is never interpreted. Never throws; any failure is null.
 */
export function commandProbe(context: PluginContext, options: { timeoutMs?: number } = {}): VersionProbe {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  return async (command, identity) => {
    let proc: ReturnType<typeof Bun.spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const words = shellWords(command)
      if (!words || words.length === 0) return null
      const line = [...words, '--version'].map(singleQuote).join(' ')
      // detached makes the child a group leader so a timeout can kill its descendants; the
      // installed bun typings predate the option
      const spawnOptions = {
        env: context.launch.env({ ...identity, agent: 'claude' }),
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true
      } as const
      proc = Bun.spawn(
        context.launch.commandArgv(line),
        spawnOptions as unknown as Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'ignore'>
      )
      const running = proc
      const stdout = running.stdout as ReadableStream<Uint8Array>
      const reader = stdout.getReader()
      const finished = (async () => {
        const chunks: Uint8Array[] = []
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        const code = await running.exited
        return code === 0 ? Buffer.concat(chunks).toString('utf8') : null
      })()
      finished.catch(() => {})
      const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          killProbe(running)
          reader.cancel().catch(() => {})
          resolve(null)
        }, timeoutMs)
      })
      return await Promise.race([finished, timedOut])
    } catch {
      if (proc) killProbe(proc)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Splits text into words the way a POSIX shell would, expanding nothing. Null when a quote is left open. */
function shellWords(text: string): string[] | null {
  const words: string[] = []
  let current = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
    } else if (quote === '"') {
      const next = text[i + 1]
      if (ch === '"') quote = null
      else if (ch === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
        if (next !== '\n') current += next
        i++
      } else current += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      inWord = true
    } else if (ch === '\\' && i + 1 < text.length) {
      const next = text[++i]!
      if (next !== '\n') {
        current += next
        inWord = true
      }
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current)
      current = ''
      inWord = false
    } else {
      current += ch
      inWord = true
    }
  }
  if (quote) return null
  if (inWord) words.push(current)
  return words
}
