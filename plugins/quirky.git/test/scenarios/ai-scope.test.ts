import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { buildCommitMessagePrompt } from '../../src/daemon/ai-prompts'
import { startAiWorld, type AiWorld } from './ai-world'

setDefaultTimeout(90_000)

let w: AiWorld | undefined
afterEach(async () => {
  await w?.cleanup()
  w = undefined
})

async function fails(promise: Promise<unknown>): Promise<{ code: number; message: string; data: { reason?: string } }> {
  try {
    await promise
  } catch (error) {
    const rpc = error as RpcError
    return { code: rpc.code, message: rpc.message, data: (rpc.data ?? {}) as { reason?: string } }
  }
  throw new Error('expected the call to fail')
}

const CHANGED_UTIL = 'export const a = 10\nexport const b = 2\nexport const c = 3\nexport const d = 4\n'
const STAGED_DIFF = ['diff', '--cached', '--patch', '--minimal', '--no-color', '--no-ext-diff']

/** An unstaged edit to util.ts and an untracked file, with nothing staged. */
function leaveUnstaged(world: AiWorld): void {
  world.write('util.ts', CHANGED_UTIL)
  world.write('fresh.ts', 'export const fresh = 1\n')
}

describe('the commit message prompt by scope', () => {
  const input = { branch: 'b', stagedFiles: 'M\ta', patch: '', patchOmitted: true }

  test('the omission note names the uncommitted list for all and the staged list otherwise', () => {
    expect(buildCommitMessagePrompt({ ...input, scope: 'all' })).toContain('infer the change from the uncommitted file list above')
    expect(buildCommitMessagePrompt(input)).toContain('infer the change from the staged file list above')
    expect(buildCommitMessagePrompt({ ...input, scope: 'staged' })).toBe(buildCommitMessagePrompt(input))
  })
})

describe('generateCommitMessage scope', () => {
  test('all builds the prompt from the unstaged and untracked changes when nothing is staged', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { reply: 'Add fresh and bump a\n\nBoth changes.\n' })
    leaveUnstaged(w)

    const result = await w.api('generateCommitMessage', { scope: 'all' })
    expect(result).toMatchObject({ subject: 'Add fresh and bump a', agent: 'claude' })

    const { stdin, runs } = w.recorded('claude')
    expect(runs).toBe(1)
    expect(stdin).toContain('Branch: zoe/feat\n\nUncommitted files (staged, unstaged and untracked):\nA\tfresh.ts\nM\tutil.ts\n')
    expect(stdin).toContain('\nUncommitted patch:\n```diff\n')
    expect(stdin).toContain('- Use only the uncommitted changes below (staged, unstaged and untracked) as context.')
    expect(stdin).not.toContain('Staged files')
    expect(stdin).not.toContain('Staged patch')
    expect(stdin).not.toContain('staged changes below')
    expect(stdin).toContain('-export const a = 1\n+export const a = 10')
    expect(stdin).toContain('+export const fresh = 1')
    expect(w.git('status', '--porcelain')).toBe(' M util.ts\n?? fresh.ts\n')
  })

  test('all covers staged and unstaged changes together, each file once', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { reply: 'Change both' })
    w.write('util.ts', CHANGED_UTIL)
    w.git('add', 'util.ts')
    w.write('util.ts', `${CHANGED_UTIL}export const e = 5\n`)
    w.write('math.ts', 'changed\n')

    await w.api('generateCommitMessage', { scope: 'all' })
    const { stdin } = w.recorded('claude')
    expect(stdin).toContain('Uncommitted files (staged, unstaged and untracked):\nM\tmath.ts\nM\tutil.ts\n')
    expect(stdin).toContain('+export const e = 5')
    expect(stdin).toContain('+export const a = 10')
    expect(stdin).toContain('+changed')
  })

  test('all with nothing changed at all fails instead of asking the agent', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { reply: 'x' })
    const failure = await fails(w.api('generateCommitMessage', { scope: 'all' }))
    expect(failure).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'nothing-changed' } })
    expect(w.recorded('claude').runs).toBe(0)
  })

  test('staged, and an omitted scope, still need something staged and read only the staged change', async () => {
    w = await startAiWorld()
    await w.oneShot('claude', { reply: 'Bump a' })
    leaveUnstaged(w)

    for (const params of [{}, { scope: 'staged' }]) {
      expect(await fails(w.api('generateCommitMessage', params))).toMatchObject({
        code: RpcErrorCode.Conflict,
        message: 'No staged changes to summarize.',
        data: { reason: 'nothing-staged' }
      })
    }
    expect(w.recorded('claude').runs).toBe(0)

    w.git('add', 'util.ts')
    await w.api('generateCommitMessage', { scope: 'staged' })
    expect(w.recorded('claude').stdin).toBe(
      buildCommitMessagePrompt({ branch: 'zoe/feat', stagedFiles: 'M\tutil.ts', patch: w.git(...STAGED_DIFF), patchOmitted: false })
    )
    expect(w.recorded('claude').stdin).not.toContain('fresh')
    expect(w.recorded('claude').stdin).toContain('Staged files:\nM\tutil.ts\n\nStaged patch:\n')
    expect(w.recorded('claude').stdin).not.toContain('Uncommitted')
  })

  test('a scope that is neither staged nor all is refused', async () => {
    w = await startAiWorld()
    expect((await fails(w.api('generateCommitMessage', { scope: 'everything' }))).code).toBe(RpcErrorCode.InvalidParams)
  })
})
