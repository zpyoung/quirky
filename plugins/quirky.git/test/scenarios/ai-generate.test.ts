import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { buildCommitMessagePrompt } from '../../src/daemon/ai-prompts'
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
