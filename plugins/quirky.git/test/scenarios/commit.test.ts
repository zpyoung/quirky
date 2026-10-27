import { afterEach, describe, expect, test } from 'bun:test'
import { installHook, isolateScenarioGit, jsonError, startScenario, type Scenario } from './fixture'

const { scratch } = isolateScenarioGit()
let s: Scenario | undefined
afterEach(async () => {
  await s?.cleanup()
  s = undefined
})

const stageMath = (scenario: Scenario) => {
  scenario.write('math.ts', 'a\nb\nc\nd\ne\nf\n')
  scenario.gitIn('add', 'math.ts')
}

describe('commit', () => {
  test('a commit returns the new sha and announces one change', async () => {
    s = await startScenario(scratch)
    stageMath(s)
    const before = s.changedEvents()
    const { sha } = await s.api('commit', { message: 'Add math' })
    expect(sha).toBe(s.gitIn('rev-parse', 'HEAD'))
    expect(s.gitIn('log', '-1', '--format=%s')).toBe('Add math')
    await Bun.sleep(60)
    expect(s.changedEvents()).toBe(before + 1)
  })

  test('SC-26: an empty message is refused and nothing is committed (CLI)', async () => {
    s = await startScenario(scratch)
    stageMath(s)
    const head = s.gitIn('rev-parse', 'HEAD')
    const result = await s.cli(['git', 'commit', '--message', '   '])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Commit message is required')
    expect(s.gitIn('rev-parse', 'HEAD')).toBe(head)
  })

  test('SC-27: a failing lint hook blocks the commit with its summary and output (CLI)', async () => {
    s = await startScenario(scratch)
    stageMath(s)
    installHook(s, 'pre-commit', 'echo "eslint found 2 problems"; exit 1')
    const head = s.gitIn('rev-parse', 'HEAD')

    const result = await s.cli(['git', 'commit', '--message', 'Add math', '--json'])
    expect(result.code).toBe(1)
    const error = jsonError(result)
    expect(error).toMatchObject({
      code: 'conflict',
      message: 'Lint failed during commit.',
      reason: 'lint',
      data: { reason: 'lint', summary: 'Lint failed during commit.' }
    })
    expect(error.data!.output).toContain('eslint found 2 problems')
    expect(s.gitIn('rev-parse', 'HEAD')).toBe(head)
  })

  test('SC-27: a pre-commit hook without a linter is a hook failure; any other failure gives its first line', async () => {
    s = await startScenario(scratch)
    stageMath(s)
    installHook(s, 'pre-commit', 'echo "pre-commit: missing header"; exit 1')
    expect(await s.fails(s.api('commit', { message: 'x' }))).toMatchObject({
      code: -32009,
      message: 'Pre-commit hook failed.',
      data: { reason: 'hook', summary: 'Pre-commit hook failed.' }
    })

    installHook(s, 'pre-commit', 'echo "npm warn old"; echo "boom: broke"; exit 1')
    expect(await s.fails(s.api('commit', { message: 'x' }))).toMatchObject({
      message: 'boom: broke',
      data: { reason: 'failed', summary: 'boom: broke' }
    })
  })

  test('a failed commit announces nothing, and with nothing staged says "Commit failed."', async () => {
    s = await startScenario(scratch)
    const before = s.changedEvents()
    expect(await s.fails(s.api('commit', { message: 'x' }))).toMatchObject({ message: 'Commit failed.', data: { reason: 'failed' } })
    await Bun.sleep(60)
    expect(s.changedEvents()).toBe(before)
  })
})
