import type { LaunchHook, PluginContext } from '@quirky/protocol'
import { CLAUDE_VERSION_FLOOR, missingSuppressionArgs, versionAtLeast } from './src/core/claude-flags'

const PROBE_TIMEOUT_MS = 3000
const RETRY_AFTER_FAILURE_MS = 30 * 60_000

/** The session a probe runs for; its environment is the one the agent would get. */
export type ProbeIdentity = { sessionId: string; worktreeId: string }

/** Runs `<command> --version` and returns its stdout, or null on any failure. */
export type VersionProbe = (command: string, identity: ProbeIdentity) => Promise<string | null>

type Verdict = { allowed: boolean; retryAt: number }

/**
 * Decides per command whether the Claude on this machine is new enough for the suppression flags.
 * A pass is kept for the gate's life; a failure (old, unreadable, probe error or timeout) is kept
 * for 30 minutes so a broken install is not probed on every launch but an upgrade is noticed.
 * Concurrent calls for one command share one probe.
 */
export class ClaudeVersionGate {
  private readonly verdicts = new Map<string, Verdict>()
  private readonly inFlight = new Map<string, Promise<boolean>>()

  constructor(
    private readonly probe: VersionProbe,
    private readonly now: () => number
  ) {}

  allows(command: string, identity: ProbeIdentity = { sessionId: '', worktreeId: '' }): Promise<boolean> {
    const known = this.verdicts.get(command)
    if (known && (known.allowed || this.now() < known.retryAt)) return Promise.resolve(known.allowed)
    const running = this.inFlight.get(command)
    if (running) return running
    const started = this.run(command, identity).finally(() => this.inFlight.delete(command))
    this.inFlight.set(command, started)
    return started
  }

  private async run(command: string, identity: ProbeIdentity): Promise<boolean> {
    let allowed = false
    try {
      const output = await this.probe(command, identity)
      allowed = output !== null && versionAtLeast(output, CLAUDE_VERSION_FLOOR) === true
    } catch {
      allowed = false
    }
    this.verdicts.set(command, { allowed, retryAt: this.now() + RETRY_AFTER_FAILURE_MS })
    return allowed
  }
}

function singleQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}

/**
 * The default probe: runs the command under the daemon's login shell with the session's launch
 * environment, and kills it after `timeoutMs`. Each word of the configured command is quoted, so
 * shell syntax in it is never interpreted. Never throws; any failure is null.
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
      proc = Bun.spawn(context.launch.commandArgv(line), {
        env: context.launch.env({ ...identity, agent: 'claude' }),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore'
      })
      const running = proc
      const finished = (async () => {
        const [stdout, code] = await Promise.all([new Response(running.stdout as ReadableStream).text(), running.exited])
        return code === 0 ? stdout : null
      })()
      const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          running.kill()
          resolve(null)
        }, timeoutMs)
      })
      return await Promise.race([finished, timedOut])
    } catch {
      proc?.kill()
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Splits text into words the way a POSIX shell would, expanding nothing. Null when a quote is
 * left open.
 */
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

/**
 * The `claude-ask` launch hook: adds the suppression flags to a Claude launch when the installed
 * Claude clears the version gate, skipping any flag the configured command, args or an earlier
 * hook already sets. It never throws and returns no patch on any doubt, so a launch is never
 * blocked or altered by a failure here.
 */
export function suppressionHook(context: PluginContext, gate: ClaudeVersionGate): LaunchHook {
  return async (launch) => {
    try {
      const agent = (await context.call('quirky.agents/get', { agent: 'claude' })) as { command?: unknown; args?: unknown }
      if (typeof agent.command !== 'string') return {}
      const commandWords = shellWords(agent.command)
      const argWords = shellWords(typeof agent.args === 'string' ? agent.args : '')
      if (!commandWords || !argWords || commandWords.length === 0) return {}
      if (!(await gate.allows(agent.command, { sessionId: launch.sessionId, worktreeId: launch.worktreeId }))) return {}
      return { args: missingSuppressionArgs([...commandWords, ...argWords, ...launch.args]) }
    } catch {
      return {}
    }
  }
}
