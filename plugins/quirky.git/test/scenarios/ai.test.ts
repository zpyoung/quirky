import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { buildCommitMessagePrompt, buildFixCommitFailurePrompt, buildFixPushFailurePrompt, buildResolveConflictsPrompt } from '../../src/daemon/ai-prompts'
import { isAlive, startAiWorld, type AiWorld, type CliResult } from './ai-world'

setDefaultTimeout(90_000)

let w: AiWorld | undefined
afterEach(async () => {
  await w?.cleanup()
  w = undefined
})

type Failure = { code: number; message: string; data: { reason?: string } & Record<string, unknown> }

async function fails(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise
  } catch (error) {
    const rpc = error as RpcError
    return { code: rpc.code, message: rpc.message, data: (rpc.data ?? {}) as Failure['data'] }
  }
  throw new Error('expected the call to fail')
}

const json = (result: CliResult): any => {
  expect(result.stderr).not.toContain('error')
  return JSON.parse(result.stdout)
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

const CHANGED_UTIL = 'export const a = 10\nexport const b = 2\nexport const c = 30\nexport const d = 40\n'
const STAGED_DIFF = ['diff', '--cached', '--patch', '--minimal', '--no-color', '--no-ext-diff']

/** `util.ts` with three changed lines, staged. */
function stageUtil(world: AiWorld): void {
  world.write('util.ts', CHANGED_UTIL)
  world.git('add', 'util.ts')
}

const startsOf = (world: AiWorld, agent: string) =>
  world.e2e.fakeLog(agent).filter((event): event is Extract<typeof event, { type: 'start' }> => event.type === 'start')

/** The starts of a terminal fake once at least `count` have been logged. */
async function startsAfter(world: AiWorld, agent: string, count: number) {
  await world.e2e.waitForFakeLog(agent, () => startsOf(world, agent).length >= count, 15_000)
  return startsOf(world, agent)
}

const valuesAfter = (argv: string[], ...flags: string[]) =>
  argv.flatMap((arg, index) => (flags.includes(arg) && argv[index + 1] !== undefined ? [argv[index + 1]!] : []))

const codexEffortValues = (argv: string[]) => {
  const values: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const value =
      arg === '-c' || arg === '--config'
        ? argv[++index]
        : arg.startsWith('--config=')
          ? arg.slice('--config='.length)
          : arg.startsWith('-c') && arg.length > 2
            ? arg.slice(2)
            : undefined
    if (value?.startsWith('model_reasoning_effort=')) values.push(value.slice('model_reasoning_effort='.length))
  }
  return values
}

describe('R2 recipe launch options', () => {
  test('commit-message picks and raw arguments resolve to one-shot argv without changing the generated text', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { reply: 'Use indexes\n\nAvoid copying.\n' })
    stageUtil(w)

    await w.api('setAiRecipe', {
      action: 'commitMessage',
      scope: 'global',
      agent: 'claude',
      args: '--model fable --effort max --model opus --effort low',
      launchOptions: { model: 'opus', optionValues: { effort: 'high' } }
    })
    const raw = await w.api('generateCommitMessage')
    expect(raw).toEqual({ message: 'Use indexes\n\nAvoid copying.', subject: 'Use indexes', body: 'Avoid copying.', agent: 'claude' })
    expect(valuesAfter(w.recorded('claude').argv, '--model')).toEqual(['fable'])
    expect(valuesAfter(w.recorded('claude').argv, '--effort')).toEqual(['max'])

    await w.api('setAiRecipe', { action: 'commitMessage', scope: 'global', args: '' })
    const picked = await w.api('generateCommitMessage')
    expect(picked.subject).toBe('Use indexes')
    expect(valuesAfter(w.recorded('claude').argv, '--model')).toEqual(['opus'])
    expect(valuesAfter(w.recorded('claude').argv, '--effort')).toEqual(['high'])

    await w.api('setAiRecipe', {
      action: 'commitMessage',
      scope: 'global',
      launchOptions: { optionValues: { effort: 'xhigh' } }
    })
    await w.api('generateCommitMessage')
    expect(valuesAfter(w.recorded('claude').argv, '--model')).toEqual(['sonnet'])
    expect(valuesAfter(w.recorded('claude').argv, '--effort')).toEqual(['xhigh'])
    expect(w.recorded('claude').runs).toBe(3)
    expect(existsSync(join(w.e2e.userHome, '.claude'))).toBe(false)
  })

  test('AI Fix applies raw Codex arguments ahead of picks and configured defaults while preserving its prompt and snapshot', async () => {
    w = await startAiWorld({ fakes: { codex: { raw: true } } })
    await w.call('setting.set', { id: 'setting:quirky.agents/workspace-trust', value: false })
    const codexDirectory = join(w.e2e.userHome, '.codex')
    const codexConfig = join(codexDirectory, 'config.toml')
    const initialConfig = 'model = "user-config-sentinel"\n'
    mkdirSync(codexDirectory, { recursive: true })
    writeFileSync(codexConfig, initialConfig)
    const failure = await failCommit(w, 'Rename index')
    const expected = buildFixCommitFailurePrompt({
      summary: 'Lint failed during commit.',
      error: failure.data.output as string,
      entries: [{ path: 'util.ts', status: 'modified', area: 'staged' }],
      worktreePath: w.feat.path,
      commitMessage: 'Rename index'
    })
    await w.api('setAiRecipe', {
      action: 'fixCommitFailure',
      scope: 'repo',
      agent: 'codex',
      args: '--model gpt-5.2-codex -c model_reasoning_effort=low',
      launchOptions: { model: 'gpt-5.5', optionValues: { effort: 'high' } }
    })

    const result = await w.api('aiFix', { action: 'fixCommitFailure' })
    expect(result.prompt).toBe(expected)
    const started = await startsAfter(w, 'codex', 1)
    expect(valuesAfter(started[0]!.argv, '-m', '--model')).toEqual(['gpt-5.2-codex'])
    expect(codexEffortValues(started[0]!.argv)).toEqual(['low'])
    const session = await w.call('quirky.session/get', { session: result.session })
    expect(session.launchSettings.options).toMatchObject({
      model: { source: 'extra-args' },
      effort: { source: 'extra-args' }
    })
    expect(readFileSync(codexConfig, 'utf8')).toBe(initialConfig)
  })

  test('AI Fix applies a supported effort-only selection without injecting a model', async () => {
    w = await startAiWorld({ fakes: { claude: { raw: true } } })
    await failCommit(w)
    await w.api('setAiRecipe', {
      action: 'fixCommitFailure',
      scope: 'repo',
      agent: 'claude',
      launchOptions: { optionValues: { effort: 'high' } }
    })

    const result = await w.api('aiFix', { action: 'fixCommitFailure' })
    const started = await startsAfter(w, 'claude', 1)
    expect(valuesAfter(started[0]!.argv, '--model')).toEqual([])
    expect(valuesAfter(started[0]!.argv, '--effort')).toEqual(['high'])
    const session = await w.call('quirky.session/get', { session: result.session })
    expect(session.launchSettings.options).toEqual({ effort: { value: 'high', source: 'explicit' } })
  })
})

describe('R1 recipe launch options', () => {
  test('R1: launch choices inherit, clear, reset and persist only for a matching agent', async () => {
    w = await startAiWorld()
    const read = () => w!.api('aiRecipe', { action: 'commitMessage' })
    const globalOptions = { model: 'opus', optionValues: { effort: 'high' } }
    const repoOptions = { model: 'fable', optionValues: { effort: 'max' } }
    const initial = await read()
    expect(initial.sources.launchOptions).toBe('default')
    expect(initial.launchOptions ?? {}).toEqual({})

    await w.api('setAiRecipe', {
      action: 'commitMessage',
      scope: 'global',
      agent: 'claude',
      args: '--model sonnet',
      template: 'T {basePrompt}',
      launchOptions: globalOptions
    })
    expect(await read()).toMatchObject({
      agent: 'claude',
      args: '--model sonnet',
      template: 'T {basePrompt}',
      launchOptions: globalOptions,
      sources: { agent: 'global', args: 'global', template: 'global', launchOptions: 'global' }
    })

    await w.api('setAiRecipe', { action: 'commitMessage', scope: 'repo', launchOptions: repoOptions })
    expect(await read()).toMatchObject({
      launchOptions: repoOptions,
      sources: { args: 'global', template: 'global', launchOptions: 'repo' }
    })
    await w.call('plugin.disable', { id: 'quirky.git' })
    await w.call('plugin.enable', { id: 'quirky.git' })
    expect(await read()).toMatchObject({
      launchOptions: repoOptions,
      sources: { launchOptions: 'repo' }
    })

    await w.api('setAiRecipe', { action: 'commitMessage', scope: 'repo', launchOptions: {} })
    expect(await read()).toMatchObject({
      launchOptions: {},
      args: '--model sonnet',
      template: 'T {basePrompt}',
      sources: { args: 'global', template: 'global', launchOptions: 'repo' }
    })
    await w.api('setAiRecipe', { action: 'commitMessage', scope: 'repo', launchOptions: null })
    expect(await read()).toMatchObject({
      launchOptions: globalOptions,
      args: '--model sonnet',
      template: 'T {basePrompt}',
      sources: { launchOptions: 'global' }
    })

    await w.api('setAiRecipe', { action: 'commitMessage', scope: 'repo', launchOptions: repoOptions })
    await w.api('setAiRecipe', { action: 'commitMessage', scope: 'repo', agent: 'codex' })
    const switched = await read()
    expect(switched).toMatchObject({
      agent: 'codex',
      args: '--model sonnet',
      template: 'T {basePrompt}',
      sources: { agent: 'repo', args: 'global', template: 'global', launchOptions: 'default' }
    })
    expect(switched.launchOptions ?? {}).toEqual({})

    const malformed = await fails(
      w.api('setAiRecipe', {
        action: 'commitMessage',
        scope: 'repo',
        launchOptions: { model: 'gpt-5.5', optionValues: { effort: 'not-a-catalog-choice' } }
      })
    )
    expect(malformed.code).toBe(RpcErrorCode.InvalidParams)
    expect(await read()).toEqual(switched)

    expect((await w.api('setAiRecipe', { action: 'commitMessage', scope: 'repo', reset: true })).saved).toBe(true)
    expect(await read()).toMatchObject({
      agent: 'claude',
      launchOptions: globalOptions,
      sources: { agent: 'global', launchOptions: 'global' }
    })
    expect((await w.api('setAiRecipe', { action: 'commitMessage', scope: 'global', reset: true })).saved).toBe(true)
    const reset = await read()
    expect(reset).toMatchObject({
      agent: null,
      args: '',
      template: '{basePrompt}',
      sources: { agent: 'default', args: 'default', template: 'default', launchOptions: 'default' }
    })
    expect(reset.launchOptions ?? {}).toEqual({})
  })
})

describe('R3 one-off recipe launch choices', () => {
  test('R3: one-off launch choices validate before starting and save back with the recipe', async () => {
    w = await startAiWorld({ fakes: { codex: { raw: true } } })
    await failCommit(w)
    const sessions = await w.call('quirky.session/list')

    const invalid = await fails(
      w.api('aiFix', {
        action: 'fixCommitFailure',
        agent: 'codex',
        launchOptions: { model: 'gpt-5.5', optionValues: { effort: 'not-a-codex-effort' } }
      })
    )
    expect(invalid.code).toBe(RpcErrorCode.InvalidParams)
    expect(invalid.message).toContain('effort')
    expect(startsOf(w, 'codex')).toHaveLength(0)
    expect(await w.call('quirky.session/list')).toEqual(sessions)

    const result = await w.api('aiFix', {
      action: 'fixCommitFailure',
      agent: 'codex',
      launchOptions: { model: 'gpt-5.5', optionValues: { effort: 'high' } },
      save: 'repo'
    })
    expect(result.saved).toBe(true)
    const started = await startsAfter(w, 'codex', 1)
    expect(valuesAfter(started[0]!.argv, '-m', '--model')).toEqual(['gpt-5.5'])
    expect(codexEffortValues(started[0]!.argv)).toEqual(['high'])
    expect(await w.api('aiRecipe', { action: 'fixCommitFailure' })).toMatchObject({
      agent: 'codex',
      launchOptions: { model: 'gpt-5.5', optionValues: { effort: 'high' } },
      sources: { agent: 'repo', launchOptions: 'repo' }
    })
  })
})

/** Disables every installed agent; several agents share one command, so disabling one is not enough. */
async function disableAgents(world: AiWorld): Promise<void> {
  const { agents } = (await world.call('quirky.agents/list')) as { agents: { id: string; installed: boolean }[] }
  for (const agent of agents.filter((entry) => entry.installed)) await world.call('quirky.agents/setEnabled', { agent: agent.id, enabled: false })
}

/** What the prompt holds between the opening of the diff fence and its close. */
const diffSection = (stdin: string): string => stdin.split('```diff\n')[1]!.slice(0, -'\n```'.length)

describe('generating a commit message', () => {
  test('NA-26: the default agent runs once with Orca\'s command and prompt, and the result is split', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { reply: 'Rename x to count.\n\nClearer name.\n' })
    stageUtil(w)

    const result = json(await w.cli(['git', 'generateCommitMessage', '--json']))
    expect(result).toEqual({ message: 'Rename x to count\n\nClearer name.', subject: 'Rename x to count', body: 'Clearer name.', agent: 'claude' })

    const run = w.recorded('claude')
    expect(run.runs).toBe(1)
    expect(run.argv).toEqual(['-p', '--output-format', 'text', '--model', 'sonnet', '--permission-mode', 'plan', '--effort', 'low', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}'])
    expect(run.cwd).toBe(w.feat.path)
    expect(run.closed).toBe(true)
    expect(run.stdin).toBe(buildCommitMessagePrompt({ branch: 'zoe/feat', stagedFiles: 'M\tutil.ts', patch: w.git(...STAGED_DIFF), patchOmitted: false }))
    expect(run.stdin).toContain('Branch: zoe/feat\n\nStaged files:\nM\tutil.ts\n')
    expect(w.git('status', '--porcelain')).toBe('M  util.ts\n')
  })

  test('NA-27: the output becomes a subject and body by Orca\'s rules', async () => {
    w = await startAiWorld({ fakes: { opencode: true } })
    stageUtil(w)
    const generate = async (reply: string, agent?: string) => {
      await w!.oneShot(agent ?? 'claude', { reply })
      return w!.api('generateCommitMessage', agent === undefined ? {} : { agent })
    }

    const long = 'Add parser for the new config format and wire it into the loader and the CLI.'
    const a = await generate(long)
    expect(a.subject).toBe(long.slice(0, 72).trimEnd())
    expect(a.body).toBe('')
    expect(a.message).toBe(a.subject)
    expect((await generate('')).message).toBe('Update project files')
    const c = await generate('Fix crash...\n\n\nBecause the list was empty.\n')
    expect([c.subject, c.body, c.message]).toEqual(['Fix crash', 'Because the list was empty.', 'Fix crash\n\nBecause the list was empty.'])
    const d = await generate('Generating…\n```text\nFix crash\n\nBecause.\n```\n')
    expect([d.subject, d.body]).toEqual(['Fix crash', 'Because.'])
    const e = await generate('<think>plan it</think>\n- Fix crash\n')
    expect([e.subject, e.body]).toEqual(['Fix crash', ''])

    const events = (...lines: object[]) => lines.map((line) => JSON.stringify(line)).join('\n')
    const f = await generate(events({ type: 'step_start' }, { type: 'text', part: { id: 'a', text: 'Fix crash' } }, { type: 'step_finish' }), 'opencode')
    expect([f.subject, f.agent]).toEqual(['Fix crash', 'opencode'])
    const g = await fails(generate(events({ type: 'error', error: { data: { message: 'model not found' } } }), 'opencode'))
    expect(g).toMatchObject({ code: RpcErrorCode.Conflict, message: 'OpenCode failed: model not found', data: { reason: 'failed' } })
  })

  test('NA-28: a patch over the budget is shared fairly and cut on line boundaries', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { reply: 'Add files' })
    const lines = (tag: string) => Array.from({ length: 3000 }, (_, i) => `${tag} line ${i} ${'x'.repeat(30)}`).join('\n') + '\n'
    w.write('big1.txt', lines('one'))
    w.write('big2.txt', lines('two'))
    w.git('add', 'big1.txt', 'big2.txt')

    await w.api('generateCommitMessage')
    const patch = diffSection(w.recorded('claude').stdin)
    expect(patch.length).toBeLessThanOrEqual(200_000)
    expect(patch).toContain('diff --git a/big1.txt')
    expect(patch).toContain('diff --git a/big2.txt')
    expect(patch.match(/\.\.\.\(diff truncated, \d+ bytes omitted\)\n/g)).toHaveLength(2)
    const [first, second] = patch.split('diff --git a/big2.txt')
    expect(Math.abs(first!.length - second!.length)).toBeLessThan(1000)
  })

  test('NA-28: a patch over 10 MiB is replaced by the omission text', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { reply: 'Add huge' })
    w.write('huge.txt', `${'x'.repeat(79)}\n`.repeat(140_000))
    w.git('add', 'huge.txt')

    await w.api('generateCommitMessage')
    expect(diffSection(w.recorded('claude').stdin)).toBe('(diff omitted — too large to read; infer the change from the staged file list above)')
  })

  test('NA-28: a file list over 6000 characters is cut there', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { reply: 'Add files' })
    for (let i = 0; i < 400; i++) w.write(`files/${'n'.repeat(12)}-${String(i).padStart(3, '0')}.txt`, 'x\n')
    w.git('add', 'files')

    await w.api('generateCommitMessage')
    const section = w.recorded('claude').stdin.split('Staged files:\n')[1]!.split('\n\nStaged patch:')[0]!
    expect(section.indexOf('\n\n[truncated: ')).toBe(6000)
    expect(section.startsWith('A\tfiles/nnnnnnnnnnnn-000.txt\n')).toBe(true)
  })

  test('NA-29: errors are reported with their reasons and nothing hangs', async () => {
    w = await startAiWorld({ fakes: { aider: true } })
    await w.oneShot('claude', { reply: 'x' })

    const nothing = await fails(w.api('generateCommitMessage'))
    expect(nothing).toMatchObject({ code: RpcErrorCode.Conflict, message: 'No staged changes to summarize.', data: { reason: 'nothing-staged' } })
    stageUtil(w)

    await w.oneShot('claude', { stderr: 'quota exceeded\n', exitCode: 3 })
    expect(await fails(w.api('generateCommitMessage'))).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Claude failed: quota exceeded', data: { reason: 'failed' } })

    await w.oneShot('claude', { bytes: 5 * 1024 * 1024 })
    expect(await fails(w.api('generateCommitMessage'))).toMatchObject({ message: 'Claude produced more than 4 MiB of output.', data: { reason: 'too-much-output' } })

    await w.oneShot('claude', { reply: 'x' })
    await w.call('quirky.agents/configure', { agent: 'claude', command: '/nonexistent/dir/claude' })
    expect(await fails(w.api('generateCommitMessage'))).toMatchObject({
      message: 'Claude could not be started. Check the agent command in Settings and try again.',
      data: { reason: 'not-started' }
    })

    await w.call('quirky.agents/setDefault', { agent: 'aider' })
    expect(await fails(w.api('generateCommitMessage'))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: "Aider can't generate text. Pick another agent.",
      data: { reason: 'cannot-generate' }
    })
    expect(w.git('status', '--porcelain')).toBe('M  util.ts\n')
  })

  test('NA-29: with no enabled agent the call says so', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { reply: 'x' })
    stageUtil(w)
    await disableAgents(w)
    expect(await fails(w.api('generateCommitMessage'))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'No enabled AI agents. Configure agents in Settings.',
      data: { reason: 'no-agents' }
    })
  })

  test('NA-29: an agent that ignores SIGTERM is killed with its whole group at the time limit', async () => {
    w = await startAiWorld({ generateTimeoutMs: 1500 })
    await w.oneShot('claude', { hangs: true })
    stageUtil(w)

    const failure = await fails(w.api('generateCommitMessage'))
    expect(failure).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Claude did not finish within 1.5 seconds.', data: { reason: 'timeout' } })
    const { agent, child } = w.pids('claude')
    expect(agent).toBeGreaterThan(0)
    await waitUntil(() => !isAlive(agent) && !isAlive(child), 10_000)
  })

  test('NA-30: one generation per worktree, and cancelGenerate ends it with its child', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { slowSeconds: 5, reply: 'Slow' })
    stageUtil(w)

    expect(await w.api('cancelGenerate')).toEqual({ cancelled: false })
    const first = fails(w.api('generateCommitMessage'))
    await waitUntil(() => w!.pids('claude').child > 0, 15_000)
    const busy = await fails(w.api('generateCommitMessage'))
    expect(busy).toMatchObject({ code: RpcErrorCode.Conflict, message: 'A commit message is already being generated.', data: { reason: 'busy' } })

    expect(await w.api('cancelGenerate')).toEqual({ cancelled: true })
    expect(await first).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Generation was stopped.', data: { reason: 'cancelled' } })
    const { agent, child } = w.pids('claude')
    await waitUntil(() => !isAlive(agent) && !isAlive(child), 10_000)
    expect(w.git('status', '--porcelain')).toBe('M  util.ts\n')

    await w.oneShot('claude', { reply: 'Fast' })
    expect((await w.api('generateCommitMessage')).subject).toBe('Fast')
  })

  test('NA-30: a request ID the caller gives is the one the agents plugin can cancel', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { slowSeconds: 5, reply: 'Slow' })
    stageUtil(w)

    const running = fails(w.api('generateCommitMessage', { requestId: 'mine' }))
    await waitUntil(() => w!.pids('claude').child > 0, 15_000)
    expect(await w.call('quirky.agents/cancelGenerate', { requestId: 'mine' })).toEqual({ cancelled: true })
    expect((await running).data.reason).toBe('cancelled')
  })

  test('NA-31: a custom command takes the prompt in argv or on stdin', async () => {
    w = await startAiWorld()
    await w.oneShot('my-gen', { reply: 'Custom subject' })
    stageUtil(w)
    await w.cli(['git', 'setAiRecipe', '--action', 'commitMessage', '--scope', 'global', '--agent', 'custom'])
    const setCommand = (value: string) => w!.call('setting.set', { id: 'setting:quirky.git/ai-custom-command', value })

    await setCommand('my-gen --fast {prompt}')
    const first = json(await w.cli(['git', 'generateCommitMessage', '--json']))
    expect(first).toMatchObject({ subject: 'Custom subject', agent: 'custom' })
    const prompt = buildCommitMessagePrompt({ branch: 'zoe/feat', stagedFiles: 'M\tutil.ts', patch: w.git(...STAGED_DIFF), patchOmitted: false })
    expect(w.recorded('my-gen').argv).toEqual(['--fast', prompt])

    await setCommand('my-gen --fast')
    await w.api('generateCommitMessage')
    const second = w.recorded('my-gen')
    expect(second.argv).toEqual(['--fast'])
    expect(second.stdin).toBe(prompt)
    expect(second.closed).toBe(true)

    await setCommand('')
    expect(await fails(w.api('generateCommitMessage'))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'Set a custom command in Source Control AI settings.',
      data: { reason: 'no-custom-command' }
    })
    expect(w.recorded('my-gen').runs).toBe(2)
  })

  test('NA-32: the recipe shapes the run, and a run can override it', async () => {
    w = await startAiWorld({ fakes: { codex: true } })
    await w.call('quirky.agents/setDefault', { agent: 'claude' })
    await w.oneShot('claude', { reply: 'From Claude' })
    await w.oneShot('codex', { reply: 'From Codex' })
    stageUtil(w)
    const template = '{basePrompt}\nUse Conventional Commits on {branch}. {unknown}'
    await w.api('setAiRecipe', { action: 'commitMessage', scope: 'global', template, args: '--model haiku' })

    const before = await w.api('generateCommitMessage')
    expect(before.agent).toBe('claude')
    const claude = w.recorded('claude')
    expect(claude.argv.filter((arg) => arg === '--model')).toEqual(['--model'])
    expect(claude.argv).toContain('haiku')
    expect(claude.argv).not.toContain('sonnet')
    expect(claude.stdin).toStartWith('You are generating a single git commit message.')
    expect(claude.stdin).toEndWith('Use Conventional Commits on zoe/feat. {unknown}')

    await w.api('setAiRecipe', { action: 'commitMessage', scope: 'repo', agent: 'codex' })
    const after = await w.api('generateCommitMessage')
    expect(after.agent).toBe('codex')
    const codex = w.recorded('codex')
    expect(codex.argv.slice(0, 5)).toEqual(['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only'])
    expect(codex.argv.filter((arg) => arg === '--model')).toEqual(['--model'])
    expect(codex.stdin).toEndWith('Use Conventional Commits on zoe/feat. {unknown}')
    expect(w.recorded('claude').runs).toBe(1)

    const override = await w.api('generateCommitMessage', { agent: 'claude', template: 'Just {branch}', args: '--model opus' })
    expect(override.agent).toBe('claude')
    expect(w.recorded('claude').stdin).toBe('Just zoe/feat')
    expect(w.recorded('claude').argv).toContain('opus')
  })

  test('a detached HEAD is described as (detached) and a blank rendered prompt is refused', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { reply: 'x' })
    stageUtil(w)
    w.git('commit', '-q', '-m', 'wip')
    w.write('util.ts', 'changed\n')
    w.git('add', 'util.ts')
    w.git('checkout', '-q', '--detach')

    await w.api('generateCommitMessage')
    expect(w.recorded('claude').stdin).toContain('Branch: (detached)\n')
    expect(await fails(w.api('generateCommitMessage', { template: '  ' }))).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason: 'empty-prompt' } })
  })
})

describe('recipes', () => {
  test('NA-39: recipes are read and saved through the CLI', async () => {
    w = await startAiWorld()

    const set = json(await w.cli(['git', 'setAiRecipe', '--action', 'commitMessage', '--scope', 'global', '--agent', 'codex', '--json']))
    expect(set.saved).toBe(true)
    expect(set.recipe).toMatchObject({ agent: 'codex' })
    expect(json(await w.cli(['git', 'setAiRecipe', '--action', 'commitMessage', '--scope', 'global', '--agent', 'codex', '--json'])).saved).toBe(false)
    expect(json(await w.cli(['git', 'setAiRecipe', '--action', 'commitMessage', '--scope', 'repo', '--args=--model gpt-5.4', '--json'])).saved).toBe(true)

    const last = json(await w.cli(['git', 'aiRecipe', '--action', 'commitMessage', '--json']))
    expect(last).toMatchObject({ agent: 'codex', args: '--model gpt-5.4', template: '{basePrompt}' })
    expect(w.storedRecipes()).toEqual([
      { scope: 'global', action: 'commitMessage', agent: 'codex', args: null, template: null },
      { scope: w.feat.repoId, action: 'commitMessage', agent: null, args: '--model gpt-5.4', template: null }
    ])

    const failure = await w.cli(['git', 'aiRecipe', '--action', 'pullRequest', '--json'])
    expect(failure.code).toBe(1)
    expect(JSON.parse(failure.stderr || failure.stdout).error).toMatchObject({ code: 'invalid-params', reason: 'unknown-action' })
  })

  test('recipes are per action, fields clear and reset, and every save announces aiChanged', async () => {
    w = await startAiWorld()
    await w.api('setAiRecipe', { action: 'fixPushFailure', scope: 'global', agent: 'claude', args: '--model haiku', template: 'T {basePrompt}' })
    await w.api('setAiRecipe', { action: 'fixPushFailure', scope: 'repo', agent: 'codex' })
    expect(await w.api('aiRecipe', { action: 'fixCommitFailure' })).toMatchObject({ agent: null, sources: { agent: 'default' } })
    expect(await w.api('aiRecipe', { action: 'fixPushFailure' })).toMatchObject({
      agent: 'codex',
      args: '--model haiku',
      template: 'T {basePrompt}',
      sources: { agent: 'repo', args: 'global', template: 'global' }
    })

    const cleared = await w.api('setAiRecipe', { action: 'fixPushFailure', scope: 'repo', agent: '' })
    expect(cleared).toMatchObject({ saved: true, recipe: { agent: 'claude', sources: { agent: 'global' } } })
    expect(w.storedRecipes().filter((row) => row.scope !== 'global')).toEqual([])

    const reset = await w.api('setAiRecipe', { action: 'fixPushFailure', scope: 'global', reset: true })
    expect(reset).toMatchObject({ saved: true, recipe: { agent: null, args: '', template: '{basePrompt}' } })
    expect((await w.api('setAiRecipe', { action: 'fixPushFailure', scope: 'global', reset: true })).saved).toBe(false)
    expect(w.storedRecipes()).toEqual([])

    await waitUntil(() => w!.aiChanged().length >= 4, 10_000)
    expect(w.aiChanged().map((event) => (event as unknown as { data: unknown }).data)).toEqual([
      { repoId: null },
      { repoId: w.feat.repoId },
      { repoId: w.feat.repoId },
      { repoId: null }
    ])
    expect((await fails(w.api('setAiRecipe', { action: 'nope', scope: 'global', agent: 'claude' }))).data.reason).toBe('unknown-action')
    expect((await fails(w.api('aiFixPreview', { action: 'commitMessage' }))).data.reason).toBe('unknown-action')
  })
})

/** A staged `util.ts` whose commit a lint hook refuses; resolves with the failed commit's data. */
async function failCommit(world: AiWorld, message = 'Rename x'): Promise<Failure> {
  stageUtil(world)
  world.hook('pre-commit', 'echo "eslint: 2 problems"; exit 1')
  const failure = await fails(world.api('commit', { message }))
  expect(failure.data.reason).toBe('lint')
  return failure
}

describe('AI Fix', () => {
  test('NA-34: the commit failure prompt is Orca\'s, a Claude tab opens with it and the failure is cleared by a commit', async () => {
    w = await startAiWorld({ fakes: { claude: { raw: true } } })
    const failure = await failCommit(w)

    const preview = json(await w.cli(['git', 'aiFixPreview', '--action', 'fixCommitFailure', '--json']))
    const expected = buildFixCommitFailurePrompt({
      summary: 'Lint failed during commit.',
      error: failure.data.output as string,
      entries: [{ path: 'util.ts', status: 'modified', area: 'staged' }],
      worktreePath: w.feat.path,
      commitMessage: 'Rename x'
    })
    expect(preview.prompt).toBe(expected)
    expect(preview.recipe).toMatchObject({ action: 'fixCommitFailure', agent: null, template: '{basePrompt}' })
    expect(expected).toContain('Fix the failed git commit in this worktree and leave the user ready to retry the commit.')
    expect(expected).toContain('- Commit message the user attempted: "Rename x"')
    expect(expected).toContain('- Staged files at failure time (1):\n- "util.ts" (modified, staged)')
    expect(startsOf(w, 'claude')).toHaveLength(0)

    const result = json(await w.cli(['git', 'aiFix', '--action', 'fixCommitFailure', '--json']))
    expect(result).toMatchObject({ agent: 'claude', prompt: expected, saved: false })
    const session = (await w.call('quirky.session/get', { session: result.session })) as { agent: string; worktreeId: string }
    expect(session).toMatchObject({ agent: 'claude', worktreeId: w.feat.id })
    const starts = await startsAfter(w, 'claude', 1)
    expect(starts).toHaveLength(1)
    expect(starts[0]!.argv.join('\n')).toContain(expected)

    w.hook('pre-commit', 'exit 0')
    await w.api('commit', { message: 'Rename x' })
    expect(await fails(w.api('aiFix', { action: 'fixCommitFailure' }))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'There is no commit failure to fix.',
      data: { reason: 'no-failure' }
    })
  })

  test('NA-34: a commit failure of any reason is held, with the message and the staged files', async () => {
    w = await startAiWorld({ fakes: { claude: { raw: true } } })
    expect(await fails(w.api('aiFix', { action: 'fixCommitFailure' }))).toMatchObject({ message: 'There is no commit failure to fix.' })
    stageUtil(w)
    w.hook('pre-commit', 'echo "boom: broke"; exit 1')
    const failure = await fails(w.api('commit', { message: '  Keep me  ' }))
    expect(failure).toMatchObject({ message: 'boom: broke', data: { reason: 'failed' } })

    const { prompt } = await w.api('aiFixPreview', { action: 'fixCommitFailure' })
    expect(prompt).toContain('- Commit message the user attempted: "Keep me"')
    expect(prompt).toContain('- Failure summary: "boom: broke"')
    expect(prompt).toContain('- "util.ts" (modified, staged)')
  })

  test('NA-35: the push failure prompt is Orca\'s, lists at most 40 files, and a successful push clears it', async () => {
    w = await startAiWorld({ fakes: { claude: { raw: true } } })
    w.addOrigin()
    w.write('one.txt', '1\n')
    w.git('add', 'one.txt')
    w.git('commit', '-q', '-m', 'one')
    for (let i = 0; i < 45; i++) w.write(`more/f${String(i).padStart(2, '0')}.txt`, 'x\n')
    w.hook('pre-push', 'echo "husky - pre-push hook exited with code 1"; exit 1')

    const failure = await fails(w.api('push'))
    expect(failure).toMatchObject({ message: 'Pre-push hook failed.', data: { reason: 'hook' } })
    const status = await w.api('status')
    const entries = status.entries.map((entry: any) => ({ path: entry.path, status: entry.status, area: entry.area }))
    expect(entries).toHaveLength(45)
    const expected = buildFixPushFailurePrompt({
      summary: 'Pre-push hook failed.',
      error: failure.data.output as string,
      entries,
      worktreePath: w.feat.path,
      branchName: 'zoe/feat'
    })

    const result = json(await w.cli(['git', 'aiFix', '--action', 'fixPushFailure', '--json']))
    expect(result).toMatchObject({ agent: 'claude', prompt: expected })
    expect(result.prompt).toContain('Fix the failed git push in this worktree and leave the user ready to retry the push.')
    expect(result.prompt).toContain('- Branch: "zoe/feat"')
    expect(result.prompt).toContain('Changed files at failure time (45):')
    expect(result.prompt).toContain('- ...5 more changed files omitted...')
    expect(result.prompt).toContain('- Do not push, create a pull request, or assume any hosted git provider.')
    expect(await startsAfter(w, 'claude', 1)).toHaveLength(1)

    w.hook('pre-push', 'exit 0')
    await w.api('push')
    expect(await fails(w.api('aiFix', { action: 'fixPushFailure' }))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'There is no push failure to fix.',
      data: { reason: 'no-failure' }
    })
  })

  test('NA-35: a push the remote refused is not a held failure', async () => {
    w = await startAiWorld({ fakes: { claude: { raw: true } } })
    w.write('one.txt', '1\n')
    w.git('add', 'one.txt')
    w.git('commit', '-q', '-m', 'one')
    expect((await fails(w.api('push'))).data.reason).not.toMatch(/^(lint|hook)$/)
    expect((await fails(w.api('aiFixPreview', { action: 'fixPushFailure' }))).data.reason).toBe('no-failure')
  })

  test('NA-36: Resolve with AI lists the unresolved files of a merge and of a rebase', async () => {
    w = await startAiWorld({ fakes: { claude: { raw: true } } })
    expect(await fails(w.api('aiFix', { action: 'resolveConflicts' }))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'There are no conflicts to resolve.',
      data: { reason: 'no-conflicts' }
    })
    w.git('branch', 'other')
    w.git('checkout', '-q', 'other')
    w.write('util.ts', 'theirs\n')
    w.git('rm', '-q', 'math.ts')
    w.git('commit', '-q', '-am', 'theirs')
    w.git('checkout', '-q', 'zoe/feat')
    w.write('util.ts', 'ours\n')
    w.write('math.ts', 'ours too\n')
    w.git('commit', '-q', '-am', 'ours')
    expect(w.gitTry('merge', '-q', 'other').code).toBe(1)

    const result = json(await w.cli(['git', 'aiFix', '--action', 'resolveConflicts', '--json']))
    const expected = buildResolveConflictsPrompt({
      conflictOperation: 'merge',
      entries: [
        { path: 'math.ts', conflict: { kind: 'deleted_by_them', state: 'unresolved' } },
        { path: 'util.ts', conflict: { kind: 'both_modified', state: 'unresolved' } }
      ],
      worktreePath: w.feat.path
    })
    expect(result.prompt).toBe(expected)
    expect(result.prompt).toContain('Resolve the current merge conflicts and complete the current git operation in this worktree.')
    expect(result.prompt).toContain('- Operation: merge\n- Continue command: git merge --continue\n- Conflicted files (2):')
    expect(result.prompt).toContain('- "math.ts" (Deleted by them)')
    expect(result.prompt).toContain('- "util.ts" (Both modified)')
    expect(result.prompt).not.toContain('Skip command')

    w.git('merge', '--abort')
    expect(w.gitTry('rebase', 'other').code).toBe(1)
    const rebase = (await w.api('aiFixPreview', { action: 'resolveConflicts' })).prompt as string
    expect(rebase).toContain('Resolve the current rebase conflicts')
    expect(rebase).toContain('- Operation: rebase')
    expect(rebase).toContain('- Continue command: git rebase --continue')
    expect(rebase).toContain('- Skip command: git rebase --skip')
    expect(rebase).toContain('git show --stat --patch REBASE_HEAD')
  })

  test('NA-37: a launch can use another agent, arguments and template, and save them as the repository recipe', async () => {
    w = await startAiWorld({ fakes: { claude: { raw: true }, codex: { raw: true } } })
    await failCommit(w)
    const run = { action: 'fixCommitFailure', agent: 'codex', args: '--model gpt-5.4', template: '{basePrompt}\nKeep the change small.' }

    const first = await w.api('aiFix', { ...run, save: 'repo' })
    expect(first).toMatchObject({ agent: 'codex', saved: true })
    expect(first.prompt).toEndWith('\nKeep the change small.')
    const starts = await startsAfter(w, 'codex', 1)
    expect(starts).toHaveLength(1)
    expect(starts[0]!.argv).toContain('--model')
    expect(starts[0]!.argv).toContain('gpt-5.4')
    expect(w.storedRecipes()).toEqual([{ scope: w.feat.repoId, action: 'fixCommitFailure', agent: 'codex', args: '--model gpt-5.4', template: '{basePrompt}\nKeep the change small.' }])

    expect(await w.api('aiFix', { ...run, save: 'repo' })).toMatchObject({ saved: false })
    const recipe = await w.api('aiRecipe', { action: 'fixCommitFailure' })
    expect(recipe).toMatchObject({ agent: 'codex', args: '--model gpt-5.4', sources: { agent: 'repo', args: 'repo', template: 'repo' } })

    const saved = await w.api('aiFix', { action: 'fixCommitFailure' })
    expect(saved).toMatchObject({ agent: 'codex', saved: false })
    expect(saved.prompt).toEndWith('\nKeep the change small.')
    expect(await startsAfter(w, 'codex', 3)).toHaveLength(3)
    expect(startsOf(w, 'claude')).toHaveLength(0)

    const global = await w.api('aiFix', { action: 'fixCommitFailure', agent: 'claude', args: '', template: '{basePrompt}', save: 'global' })
    expect(global).toMatchObject({ agent: 'claude', saved: true })
    expect(w.storedRecipes().find((row) => row.scope === 'global')).toMatchObject({ agent: 'claude', args: '', template: '{basePrompt}' })
  })

  test('NA-38: launch errors use Orca\'s text and open no tab', async () => {
    w = await startAiWorld({ fakes: { claude: { raw: true } } })
    await failCommit(w)

    const refused = await fails(w.api('aiFix', { action: 'fixCommitFailure', args: '--dangerously-skip-permissions --rm-rf' }))
    expect(refused.code).toBe(RpcErrorCode.InvalidParams)
    expect(refused.message.length).toBeGreaterThan(0)

    expect(await fails(w.api('aiFix', { action: 'fixCommitFailure', template: '   ' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'Commit failure prompt is empty. Update Source Control AI settings.',
      data: { reason: 'empty-prompt' }
    })

    await w.api('setAiRecipe', { action: 'fixCommitFailure', scope: 'repo', agent: 'gemini' })
    expect(await fails(w.api('aiFix', { action: 'fixCommitFailure' }))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'Saved AI agent is unavailable. Use Customize launch to choose another agent.',
      data: { reason: 'agent-unavailable' }
    })
    await w.api('setAiRecipe', { action: 'fixCommitFailure', scope: 'repo', reset: true })

    await disableAgents(w)
    expect(await fails(w.api('aiFix', { action: 'fixCommitFailure' }))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'No enabled AI agents. Configure agents in Settings.',
      data: { reason: 'no-agents' }
    })
    expect(startsOf(w, 'claude')).toHaveLength(0)
  })
  test('branch-summary recipes launch with the exact comparison source and raw arguments outrank structured picks', async () => {
    w = await startAiWorld({ fakes: { codex: { raw: true } } })
    w.write('feature.ts', 'export const feature = true\n')
    w.git('add', 'feature.ts')
    w.git('commit', '-q', '-m', 'Add feature')
    await w.api('setAiRecipe', {
      action: 'branchSummary',
      scope: 'repo',
      agent: 'codex',
      args: '--model gpt-5.5',
      launchOptions: { model: 'gpt-5.6-sol', optionValues: { effort: 'high' } }
    })

    const preview = await w.api('aiFixPreview', { action: 'branchSummary' })
    expect(preview.prompt).toContain('Branch: "zoe/feat"')
    expect(preview.prompt).toContain('"feature.ts"')
    expect(preview.recipe).toMatchObject({ action: 'branchSummary', agent: 'codex' })
    expect(startsOf(w, 'codex')).toHaveLength(0)

    const started = await w.api('aiFix', { action: 'branchSummary' })
    expect(started).toMatchObject({ agent: 'codex', saved: false })
    const session = await w.call('quirky.session/get', { session: started.session })
    expect(session.launchSettings.options).toMatchObject({
      model: { source: 'extra-args' },
      effort: { value: 'high', source: 'explicit' }
    })
    const starts = await startsAfter(w, 'codex', 1)
    expect(valuesAfter(starts[0]!.argv, '-m', '--model')).toEqual(['gpt-5.5'])
  })
})

