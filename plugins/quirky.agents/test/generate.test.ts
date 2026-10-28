import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcError, RpcErrorCode, type QuirkyClient } from '@quirky/protocol'
import { startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'

const PLUGIN_DIR = join(import.meta.dir, '..')
const ENV_NAMES = ['HOME', 'QUIRKY_AGENT_SEARCH_DIRS', 'QUIRKY_TEST_GENERATE_TIMEOUT_MS'] as const
const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))

const A = (method: string) => `quirky.agents/${method}`
const PROMPT = 'Summarize.\nLine two with "quotes" and $HOME.'
const SETTINGS = '{"disableAllHooks":true}'
const REFUSAL = 'Error: You cannot use --strict-mcp-config when an enterprise MCP config is present'

type Fixture = {
  h: Harness
  client: QuirkyClient
  /** Where fake agents are installed. */
  bin: string
  /** Where fake agents write what they saw. */
  rec: string
  /** An existing folder to run in. */
  work: string
  call(method: string, params?: Record<string, unknown>): Promise<any>
  /** Installs `name` as an executable shell script running `body` and re-detects; `$REC` is the recording prefix for the name. */
  fake(name: string, body: string): Promise<string>
  recorded(name: string, file: string): string
  /** The arguments recorded by a recording fake, one per NUL. */
  argvOf(name: string, file?: string): string[]
}

const fixtures: Fixture[] = []

/** What every recording fake does first: note argv, folder, environment and stdin, then print `output`. */
const RECORD = `: > "$REC.argv"; for a in "$@"; do printf '%s\\0' "$a" >> "$REC.argv"; done
pwd > "$REC.cwd"
env > "$REC.env"
cat > "$REC.stdin"
echo closed > "$REC.eof"`

async function start(options: { worktree?: boolean; timeoutMs?: number } = {}): Promise<Fixture> {
  const home = mkdtempSync('/tmp/qag-g-')
  const userHome = join(home, 'user')
  const bin = join(home, 'agents')
  const rec = join(home, 'rec')
  const work = join(home, 'work')
  for (const dir of [userHome, bin, rec, work]) mkdirSync(dir, { recursive: true })

  // a login shell with a bare PATH that runs `-c` scripts as plain sh: a launch command line really
  // executes, and an agent installed on this machine is never found, only the fakes in `bin`
  // named sh so the daemon treats it as a POSIX shell and puts the quirky bin on PATH
  mkdirSync(join(home, 'shells'))
  const shell = join(home, 'shells', 'sh')
  writeFileSync(shell, '#!/bin/sh\nshift\nPATH=/usr/bin:/bin\nexport PATH\nexec /bin/sh "$@"\n')
  chmodSync(shell, 0o755)

  const builtin = join(home, 'builtin')
  mkdirSync(builtin)
  symlinkSync(PLUGIN_DIR, join(builtin, 'quirky.agents'))
  if (options.worktree) {
    writePlugin(
      builtin,
      {
        id: 'quirky.worktree',
        name: 'Worktree (test fake)',
        version: '0.0.0',
        main: 'main.ts',
        contributes: {
          method: [
            {
              id: 'resolve',
              params: { type: 'object', properties: { selector: { type: 'string' }, cwd: { type: 'string' }, worktreeId: { type: 'string' } }, required: ['selector'] }
            }
          ]
        }
      },
      {
        'main.ts': `import { writeFileSync } from 'node:fs'
export async function activate(context: any) {
  context.provide('method:quirky.worktree/resolve', (params: any) => {
    writeFileSync(${JSON.stringify(join(rec, 'resolve.json'))}, JSON.stringify(params))
    return { id: 'wt-1', path: ${JSON.stringify(work)} }
  })
}
`
      }
    )
  }

  process.env.HOME = userHome
  process.env.QUIRKY_AGENT_SEARCH_DIRS = bin
  if (options.timeoutMs === undefined) delete process.env.QUIRKY_TEST_GENERATE_TIMEOUT_MS
  else process.env.QUIRKY_TEST_GENERATE_TIMEOUT_MS = String(options.timeoutMs)

  const h = await startHarness({ home, shell, builtinPluginsDir: builtin })
  const client = await h.connect('cli')
  const fixture: Fixture = {
    h,
    client,
    bin,
    rec,
    work,
    call: (method, params = {}) => client.callAny(method, params),
    async fake(name, body) {
      const path = join(bin, name)
      writeFileSync(path, `#!/bin/sh\nREC=${join(rec, name)}\n${body}\n`)
      chmodSync(path, 0o755)
      await client.callAny(A('refresh'), {})
      return path
    },
    recorded: (name, file) => readFileSync(join(rec, `${name}.${file}`), 'utf8'),
    argvOf(name, file = 'argv') {
      const text = readFileSync(join(rec, `${name}.${file}`), 'utf8')
      return text === '' ? [] : text.slice(0, -1).split('\0')
    }
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.h.cleanup()
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

/** The RPC error a call rejects with. */
async function failure(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected the call to fail')
}

const reasonOf = (error: RpcError) => (error.data as { reason?: string } | undefined)?.reason

/** Whether `pid` is a live process; a zombie waiting for its parent to reap it is gone. */
function alive(pid: number): boolean {
  const state = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)]).stdout.toString().trim()
  return state !== '' && !state.startsWith('Z')
}

async function gone(...pids: number[]): Promise<void> {
  await waitFor(() => pids.every((pid) => !alive(pid)), 5000)
}

const pidOf = (t: Fixture, file: string) => Number(readFileSync(join(t.rec, file), 'utf8').trim())

describe('quirky.agents/generate', () => {
  test('NA-41: runs the agent once with its one-shot arguments, the prompt on stdin, then closes stdin', async () => {
    const t = await start()
    const path = await t.fake('codex', `${RECORD}\nprintf ok`)

    const result = await t.call(A('generate'), { agent: 'codex', prompt: PROMPT, cwd: t.work })

    const argv = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--model', 'gpt-5.6-terra', '-c', 'model_reasoning_effort=low']
    expect(result).toEqual({ text: 'ok', agent: 'codex', command: path, args: argv })
    expect(t.argvOf('codex')).toEqual(argv)
    expect(t.recorded('codex', 'stdin')).toBe(PROMPT)
    expect(t.recorded('codex', 'eof').trim()).toBe('closed')
    expect(t.recorded('codex', 'cwd').trim()).toBe(realpathSync(t.work))
  })

  test('the run is not a session: no session variables, no saved launch arguments, the quirky bin first on PATH', async () => {
    const t = await start()
    await t.fake('claude', `${RECORD}\nprintf ok`)
    await t.call(A('configure'), { agent: 'claude', args: '--dangerously-skip-permissions --verbose' })

    await t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work })

    const env = t.recorded('claude', 'env').split('\n')
    expect(env.some((line) => line.startsWith('QUIRKY_SESSION_ID=') || line.startsWith('QUIRKY_HOOK_URL=') || line.startsWith('QUIRKY_HOOK_TOKEN='))).toBe(false)
    expect(env).toContain(`QUIRKY_HOME=${t.h.home}`)
    expect(env.find((line) => line.startsWith('PATH='))).toStartWith(`PATH=${join(t.h.home, 'bin')}:`)
    expect(t.argvOf('claude')).toEqual(['-p', '--output-format', 'text', '--model', 'sonnet', '--permission-mode', 'plan', '--effort', 'low', '--strict-mcp-config', '--settings', SETTINGS])
  })

  test('NA-26: an agent that takes its prompt on argv gets it as one argument and an empty stdin', async () => {
    const t = await start()
    await t.fake('cursor-agent', `${RECORD}\nprintf done`)

    const result = await t.call(A('generate'), { agent: 'cursor', prompt: PROMPT, cwd: t.work })

    expect(t.argvOf('cursor-agent').slice(-2)).toEqual(['auto', PROMPT])
    expect(t.recorded('cursor-agent', 'stdin')).toBe('')
    expect(result.text).toBe('done')
    expect(result.args.at(-1)).toBe(PROMPT)
  })

  test('NA-32: the user arguments replace Orca\'s model flag and are placed before the prompt', async () => {
    const t = await start()
    await t.fake('claude', `${RECORD}\nprintf ok`)

    await t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work, args: '--model haiku --max-turns 1' })

    expect(t.argvOf('claude')).toEqual([
      '-p', '--output-format', 'text', '--model', 'haiku', '--permission-mode', 'plan', '--effort', 'low', '--strict-mcp-config', '--settings', SETTINGS, '--max-turns', '1'
    ])
  })

  test('structured selections override one-shot defaults, raw arguments override picks, and unsupported picks start nothing', async () => {
    const t = await start()
    await t.fake('claude', `echo run >> "$REC.runs"\n${RECORD}\nprintf ok`)

    await t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work, model: 'opus', optionValues: { effort: 'high' } })
    expect(t.argvOf('claude')).toEqual([
      '-p', '--output-format', 'text', '--model', 'opus', '--permission-mode', 'plan', '--effort', 'high', '--strict-mcp-config', '--settings', SETTINGS
    ])

    await t.call(A('generate'), {
      agent: 'claude',
      prompt: 'p',
      cwd: t.work,
      model: 'opus',
      optionValues: { effort: 'high' },
      args: '--model fable --effort max --model sonnet --effort low'
    })
    expect(t.argvOf('claude')).toEqual([
      '-p', '--output-format', 'text', '--model', 'fable', '--permission-mode', 'plan', '--effort', 'max', '--strict-mcp-config', '--settings', SETTINGS
    ])

    await t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work, optionValues: { effort: 'xhigh' } })
    expect(t.argvOf('claude')).toEqual([
      '-p', '--output-format', 'text', '--model', 'sonnet', '--permission-mode', 'plan', '--effort', 'xhigh', '--strict-mcp-config', '--settings', SETTINGS
    ])

    const invalid = await failure(
      t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work, model: 'haiku', optionValues: { effort: 'high' } })
    )
    expect(invalid.code).toBe(RpcErrorCode.InvalidParams)
    expect(invalid.message).toContain('effort')
    expect(t.recorded('claude', 'runs').trim().split('\n').filter(Boolean)).toHaveLength(3)
  })

  test('a command override from configure is what runs', async () => {
    const t = await start()
    await t.fake('claude', 'printf stock')
    const alt = await t.fake('my-claude', `${RECORD}\nprintf custom`)
    await t.call(A('configure'), { agent: 'claude', command: `${alt} --wrapped` })

    const result = await t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work })

    expect(result.text).toBe('custom')
    expect(result.command).toBe(alt)
    expect(result.args.slice(0, 3)).toEqual(['--wrapped', '-p', '--output-format'])
  })

  test('muse and dsh run their own one-shot command, not the interactive launch command', async () => {
    const t = await start()
    await t.fake('muse', `${RECORD}\nprintf m`)
    await t.fake('dsh', `${RECORD}\nprintf d`)
    await t.fake('dsh-tui', 'exit 9')

    expect((await t.call(A('generate'), { agent: 'muse', prompt: 'p', cwd: t.work })).text).toBe('m')
    expect((await t.call(A('generate'), { agent: 'dsh', prompt: 'p', cwd: t.work })).text).toBe('d')
    expect(t.argvOf('muse')).not.toContain('--trust-workspace')
    expect(t.argvOf('dsh')).toEqual(['--profile', 'headless', '-'])
  })

  test('NA-27: terminal colors are stripped and the text is otherwise untouched', async () => {
    const t = await start()
    await t.fake('codex', `cat > /dev/null\nprintf '\\033[32m  Fix crash\\033[0m\\n\\n'`)

    const result = await t.call(A('generate'), { agent: 'codex', prompt: 'p', cwd: t.work })

    expect(result.text).toBe('  Fix crash\n\n')
  })

  test('NA-27: OpenCode\'s JSON events are decoded, and an error event fails the run', async () => {
    const t = await start()
    const events = (...lines: object[]) => lines.map((line) => JSON.stringify(line)).join('\n')
    await t.fake('opencode', `cat > /dev/null\ncat <<'EVENTS'\n${events({ type: 'step_start' }, { type: 'text', part: { id: 'a', text: 'Fix crash' } }, { type: 'step_finish' })}\nEVENTS`)

    const ok = await t.call(A('generate'), { agent: 'opencode', prompt: 'p', cwd: t.work })
    expect(ok.text).toBe('Fix crash')

    await t.fake('opencode', `cat > /dev/null\ncat <<'EVENTS'\n${events({ type: 'error', error: { data: { message: 'model not found' } } })}\nEVENTS`)
    const error = await failure(t.call(A('generate'), { agent: 'opencode', prompt: 'p', cwd: t.work }))
    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'OpenCode failed: model not found' })
    expect(reasonOf(error)).toBe('failed')
  })

  test('NA-29: a non-zero exit reports the first lines of stderr under the agent\'s name', async () => {
    const t = await start()
    await t.fake('codex', `cat > /dev/null\necho 'quota exceeded' >&2\nexit 3`)

    const error = await failure(t.call(A('generate'), { agent: 'codex', prompt: 'p', cwd: t.work }))

    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Codex failed: quota exceeded' })
    expect(reasonOf(error)).toBe('failed')
  })

  test('NA-29: a missing agent command is "could not be started"', async () => {
    const t = await start()
    await t.fake('claude', 'exit 0')
    await t.call(A('configure'), { agent: 'claude', command: '/nonexistent/dir/claude' })

    const error = await failure(t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work }))

    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Claude could not be started. Check the agent command in Settings and try again.' })
    expect(reasonOf(error)).toBe('not-started')
  })

  test('NA-29: more than 4 MiB of output fails the run and kills the agent', async () => {
    const t = await start()
    await t.fake('codex', `echo $$ > "$REC.pid"\nhead -c 5242880 /dev/zero | tr '\\0' a\nsleep 60`)

    const error = await failure(t.call(A('generate'), { agent: 'codex', prompt: 'p', cwd: t.work }))

    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Codex produced more than 4 MiB of output.' })
    expect(reasonOf(error)).toBe('too-much-output')
    await gone(pidOf(t, 'codex.pid'))
  })

  test('NA-29: exactly 4 MiB is accepted', async () => {
    const t = await start()
    await t.fake('codex', `cat > /dev/null\nhead -c 4194304 /dev/zero | tr '\\0' a`)

    const result = await t.call(A('generate'), { agent: 'codex', prompt: 'p', cwd: t.work })

    expect(result.text.length).toBe(4 * 1024 * 1024)
  })

  test('NA-29: an agent that ignores SIGTERM and starts a child is killed with its whole group at the time limit', async () => {
    const t = await start({ timeoutMs: 300 })
    await t.fake('claude', `trap '' TERM\necho $$ > "$REC.pid"\nsleep 120 &\necho $! > "$REC.child"\nwait`)
    const began = Date.now()

    const error = await failure(t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work }))

    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Claude did not finish within 0.3 seconds.' })
    expect(reasonOf(error)).toBe('timeout')
    expect(Date.now() - began).toBeGreaterThanOrEqual(2000)
    await gone(pidOf(t, 'claude.pid'), pidOf(t, 'claude.child'))
  })

  test('the default limit is 60 seconds and a caller cannot ask for more', async () => {
    const t = await start()
    await t.fake('codex', 'exit 0')
    const error = await failure(t.call(A('generate'), { agent: 'codex', prompt: 'p', cwd: t.work, timeoutMs: 60001 }))
    expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'params.timeoutMs must be at most 60000' })
  })

  test('NA-30: cancelGenerate stops the run, its child and nothing else', async () => {
    const t = await start()
    await t.fake('claude', `echo $$ > "$REC.pid"\nsleep 120 &\necho $! > "$REC.child"\nwait`)
    const running = failure(t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work, requestId: 'r1' }))
    await waitFor(() => existsSync(join(t.rec, 'claude.child')))

    expect(await failure(t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work, requestId: 'r1' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'requestId r1 is already running'
    })
    expect(await t.call(A('cancelGenerate'), { requestId: 'r1' })).toEqual({ cancelled: true })

    const error = await running
    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Generation was stopped.' })
    expect(reasonOf(error)).toBe('cancelled')
    await gone(pidOf(t, 'claude.pid'), pidOf(t, 'claude.child'))
    expect(await t.call(A('cancelGenerate'), { requestId: 'r1' })).toEqual({ cancelled: false })
    expect(await t.call(A('cancelGenerate'), { requestId: 'never-started' })).toEqual({ cancelled: false })
  })

  test('a cancelled run settles only after a SIGTERM-resistant child of an agent that already exited is gone', async () => {
    const t = await start()
    await t.fake('claude', `echo $$ > "$REC.pid"\n(trap '' TERM; exec sleep 120) &\necho $! > "$REC.child"\nwait`)
    const running = failure(t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work, requestId: 'r1' }))
    await waitFor(() => existsSync(join(t.rec, 'claude.child')))
    const child = pidOf(t, 'claude.child')
    const began = Date.now()

    await t.call(A('cancelGenerate'), { requestId: 'r1' })
    expect(reasonOf(await running)).toBe('cancelled')

    expect(alive(child)).toBe(false)
    expect(Date.now() - began).toBeGreaterThanOrEqual(1900)
  })

  test('NA-26: Claude is retried once without --strict-mcp-config when an enterprise MCP config refuses it', async () => {
    const t = await start()
    await t.fake(
      'claude',
      `printf '%s\\0' "$@" >> "$REC.runs"; echo >> "$REC.runs"\ncat > /dev/null\ncase " $* " in *" --strict-mcp-config "*) echo '${REFUSAL}' >&2; exit 1;; esac\nprintf retried`
    )

    const result = await t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work })

    expect(result.text).toBe('retried')
    expect(result.args).not.toContain('--strict-mcp-config')
    expect(result.args.slice(-2)).toEqual(['--settings', SETTINGS])
    const runs = readFileSync(join(t.rec, 'claude.runs'), 'utf8').trim().split('\n')
    expect(runs).toHaveLength(2)
    expect(runs[0]).toContain('--strict-mcp-config')
    expect(runs[1]).not.toContain('--strict-mcp-config')
  })

  test('a failure that is not the enterprise refusal is not retried', async () => {
    const t = await start()
    await t.fake('claude', `echo run >> "$REC.runs"\ncat > /dev/null\necho 'rate limited' >&2\nexit 1`)

    const error = await failure(t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work }))

    expect(error.message).toBe('Claude failed: rate limited')
    expect(readFileSync(join(t.rec, 'claude.runs'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  test('the refusal is not retried when the retry itself fails', async () => {
    const t = await start()
    await t.fake('claude', `echo run >> "$REC.runs"\ncat > /dev/null\necho '${REFUSAL}' >&2\nexit 1`)

    const error = await failure(t.call(A('generate'), { agent: 'claude', prompt: 'p', cwd: t.work }))

    expect(error.message).toStartWith('Claude failed: Error: You cannot use --strict-mcp-config')
    expect(readFileSync(join(t.rec, 'claude.runs'), 'utf8').trim().split('\n')).toHaveLength(2)
  })

  test('NA-29: an agent with no one-shot shape cannot generate, installed or not', async () => {
    const t = await start()
    const error = await failure(t.call(A('generate'), { agent: 'aider', prompt: 'p', cwd: t.work }))
    expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams, message: "Aider can't generate text. Pick another agent." })
    expect(reasonOf(error)).toBe('cannot-generate')
  })

  test('an agent that is not installed or is disabled cannot generate', async () => {
    const t = await start()
    const missing = await failure(t.call(A('generate'), { agent: 'codex', prompt: 'p', cwd: t.work }))
    expect(missing).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'Codex is not installed.' })
    expect(reasonOf(missing)).toBe('not-installed')

    await t.fake('codex', 'printf ok')
    await t.call(A('refresh'))
    await t.call(A('setEnabled'), { agent: 'codex', enabled: false })
    const disabled = await failure(t.call(A('generate'), { agent: 'codex', prompt: 'p', cwd: t.work }))
    expect(disabled).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'Codex is disabled. Enable it in Settings.' })
    expect(reasonOf(disabled)).toBe('not-installed')

    expect(await failure(t.call(A('generate'), { agent: 'no-such-agent', prompt: 'p', cwd: t.work }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'unknown agent: no-such-agent'
    })
  })

  test('arguments that do not tokenize are refused before anything starts', async () => {
    const t = await start()
    await t.fake('codex', `echo run >> "$REC.runs"`)
    const error = await failure(t.call(A('generate'), { agent: 'codex', prompt: 'p', cwd: t.work, args: '--model "x' }))
    expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'CLI arguments are invalid: unterminated quote' })
    expect(existsSync(join(t.rec, 'codex.runs'))).toBe(false)
  })

  test('NA-41: cwd defaults to the caller\'s worktree, and `worktree` picks another', async () => {
    const t = await start({ worktree: true })
    await t.fake('codex', `${RECORD}\nprintf ok`)

    await t.call(A('generate'), { agent: 'codex', prompt: 'p' })
    expect(t.recorded('codex', 'cwd').trim()).toBe(realpathSync(t.work))
    expect(JSON.parse(readFileSync(join(t.rec, 'resolve.json'), 'utf8')).selector).toBe('current')

    await t.call(A('generate'), { agent: 'codex', prompt: 'p', worktree: 'feat' })
    expect(JSON.parse(readFileSync(join(t.rec, 'resolve.json'), 'utf8')).selector).toBe('feat')
  })

  test('NA-41: a cwd that is not an existing absolute directory is refused', async () => {
    const t = await start()
    await t.fake('codex', `${RECORD}\nprintf ok`)
    const file = join(t.work, 'a-file')
    writeFileSync(file, 'x')

    for (const cwd of [file, join(t.work, 'missing'), 'relative/dir']) {
      const error = await failure(t.call(A('generate'), { agent: 'codex', prompt: 'p', cwd }))
      expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'cwd must be an existing directory' })
    }
    expect(existsSync(join(t.rec, 'codex.argv'))).toBe(false)
  })

  test('NA-41: list marks the agents that can generate', async () => {
    const t = await start({})
    const listing = await t.call(A('list'))
    const generating = listing.agents.filter((agent: any) => agent.canGenerate).map((agent: any) => agent.id).sort()
    expect(generating).toEqual(['amp', 'antigravity', 'claude', 'codex', 'copilot', 'cursor', 'dsh', 'jcode', 'kimi', 'muse', 'omp', 'opencode', 'pi'])
    expect(listing.agents.find((agent: any) => agent.id === 'aider').canGenerate).toBe(false)
    expect(await t.call(A('get'), { agent: 'claude' })).toMatchObject({ canGenerate: true })
  })
})

describe('generate with a custom command', () => {
  test('NA-31: {prompt} puts the whole prompt in one argument and leaves stdin empty', async () => {
    const t = await start()
    const path = await t.fake('my-gen', `${RECORD}\nprintf custom`)

    const result = await t.call(A('generate'), { agent: 'custom', args: 'my-gen --fast {prompt}', prompt: PROMPT, cwd: t.work })

    expect(result).toEqual({ text: 'custom', agent: 'custom', command: path, args: ['--fast', PROMPT] })
    expect(t.argvOf('my-gen')).toEqual(['--fast', PROMPT])
    expect(t.recorded('my-gen', 'stdin')).toBe('')
  })

  test('NA-31: without {prompt} the prompt goes to stdin', async () => {
    const t = await start()
    await t.fake('my-gen', `${RECORD}\nprintf custom`)

    await t.call(A('generate'), { agent: 'custom', args: 'my-gen --fast', prompt: PROMPT, cwd: t.work })

    expect(t.argvOf('my-gen')).toEqual(['--fast'])
    expect(t.recorded('my-gen', 'stdin')).toBe(PROMPT)
    expect(t.recorded('my-gen', 'eof').trim()).toBe('closed')
  })

  test('leading NAME=value words become the run\'s environment', async () => {
    const t = await start()
    await t.fake('my-gen', `${RECORD}\nprintf ok`)

    await t.call(A('generate'), { agent: 'custom', args: 'GEN_MODE=fast my-gen', prompt: 'p', cwd: t.work })

    expect(t.recorded('my-gen', 'env').split('\n')).toContain('GEN_MODE=fast')
    expect(t.argvOf('my-gen')).toEqual([])
  })

  test('shell syntax in the command line is data, never run', async () => {
    const t = await start()
    await t.fake('my-gen', `${RECORD}\nprintf ok`)

    await t.call(A('generate'), { agent: 'custom', args: `my-gen '$(touch ${join(t.work, 'pwned')})' ; echo`, prompt: 'p', cwd: t.work })

    expect(existsSync(join(t.work, 'pwned'))).toBe(false)
    expect(t.argvOf('my-gen')[0]).toStartWith('$(touch ')
  })

  test('a custom command that does not exist names its binary', async () => {
    const t = await start()
    const error = await failure(t.call(A('generate'), { agent: 'custom', args: 'no-such-binary-xyz --fast', prompt: 'p', cwd: t.work }))
    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'no-such-binary-xyz could not be started. Check the agent command in Settings and try again.' })
    expect(reasonOf(error)).toBe('not-started')
  })

  test('a custom command failure is named by its binary', async () => {
    const t = await start()
    await t.fake('my-gen', `cat > /dev/null\necho 'bad key' >&2\nexit 2`)
    const error = await failure(t.call(A('generate'), { agent: 'custom', args: 'my-gen', prompt: 'p', cwd: t.work }))
    expect(error.message).toBe('my-gen failed: bad key')
  })

  test('an empty or unclosed command line is refused', async () => {
    const t = await start()
    expect(await failure(t.call(A('generate'), { agent: 'custom', args: '  ', prompt: 'p', cwd: t.work }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'Custom command is empty.'
    })
    expect(await failure(t.call(A('generate'), { agent: 'custom', prompt: 'p', cwd: t.work }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'Custom command is empty.'
    })
    expect(await failure(t.call(A('generate'), { agent: 'custom', args: 'my-gen "x', prompt: 'p', cwd: t.work }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'Unclosed quote in command template.'
    })
  })
})
