import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { afterEach, expect, test } from 'bun:test'
import { createGoalLoopWorld, type GoalLoopWorld } from '../../../scripts/parity/goal-loop-world'

let world: GoalLoopWorld | undefined

afterEach(async () => {
  const current = world
  world = undefined
  await current?.cleanup()
})

async function startRepo(): Promise<{ current: GoalLoopWorld; repoId: string }> {
  world = await createGoalLoopWorld()
  await world.start()

  const current = world
  const repoResult = await current.cli(['repo', 'add', current.repoPath])
  expect(repoResult.exitCode).toBe(0)
  const repo = JSON.parse(repoResult.stdout) as { id: string }

  const settingResult = await current.cli([
    'api', 'call', 'setting.set',
    '--params', JSON.stringify({
      id: 'setting:quirky.worktree/worktreesRoot',
      value: current.paths.worktreesRoot
    })
  ])
  expect(settingResult.exitCode).toBe(0)
  mkdirSync(current.paths.worktreesRoot, { recursive: true })

  return { current, repoId: repo.id }
}

function gitOutput(current: GoalLoopWorld, cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: current.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function listOwnedTree(root: string): string[] {
  if (!existsSync(root)) return []
  const paths: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      paths.push(relative(root, path))
      if (entry.isDirectory()) visit(path)
    }
  }
  visit(root)
  return paths.sort()
}

async function creationState(current: GoalLoopWorld, repoId: string) {
  const listed = await current.cli(['worktree', 'list', '--repo', `id:${repoId}`])
  expect(listed.exitCode).toBe(0)
  return {
    worktrees: JSON.parse(listed.stdout) as unknown,
    branches: gitOutput(current, current.repoPath, 'branch', '--format=%(refname) %(objectname)'),
    refs: gitOutput(current, current.repoPath, 'for-each-ref', '--format=%(refname) %(objectname)'),
    registrations: gitOutput(current, current.repoPath, 'worktree', 'list', '--porcelain'),
    ownedTree: listOwnedTree(current.paths.worktreesRoot)
  }
}

test('worktree create accepts a registered agent ID and launches it through the real CLI', async () => {
  world = await createGoalLoopWorld()
  await world.start()

  const repoResult = await world.cli(['repo', 'add', world.repoPath])
  expect(repoResult.exitCode).toBe(0)
  const repo = JSON.parse(repoResult.stdout) as { id: string }
  expect(repo.id).toBeTruthy()

  const settingResult = await world.cli([
    'api', 'call', 'setting.set',
    '--params', JSON.stringify({
      id: 'setting:quirky.worktree/worktreesRoot',
      value: world.paths.worktreesRoot
    })
  ])
  expect(settingResult.exitCode).toBe(0)

  const prompt = 'fixture-agent-omp'

  const createResult = await world.cli([
    'worktree', 'create', '--repo', `id:${repo.id}`, '--name', 'goal-loop-agent-omp',
    '--base', 'main', '--no-parent', '--setup', 'skip', '--agent', 'omp', '--prompt', prompt
  ])
  expect(createResult.exitCode).toBe(0)

  const receipt = JSON.parse(createResult.stdout) as {
    worktree: { id: string; name: string }
    agentSessionId?: string
  }
  expect(receipt.worktree.name).toBe('goal-loop-agent-omp')
  expect(receipt.agentSessionId).toEqual(expect.any(String))

  const sessionResult = await world.cli(['session', 'get', receipt.agentSessionId!])
  expect(sessionResult.exitCode).toBe(0)
  const session = JSON.parse(sessionResult.stdout) as { id: string; agent: string; worktreeId: string }
  expect(session).toMatchObject({
    id: receipt.agentSessionId,
    agent: 'omp',
    worktreeId: receipt.worktree.id
  })
}, 45_000)

test('worktree create refuses unknown agents atomically and refuses shell exactly', async () => {
  const { current, repoId } = await startRepo()
  const before = await creationState(current, repoId)

  const unknownResult = await current.cli([
    'worktree', 'create', '--repo', `id:${repoId}`, '--name', 'goal-loop-unknown-agent',
    '--base', 'main', '--no-parent', '--setup', 'skip', '--agent', 'no-such-agent'
  ])
  expect(unknownResult.exitCode).not.toBe(0)
  expect(`${unknownResult.stdout}${unknownResult.stderr}`).toContain('no-such-agent')
  expect(await creationState(current, repoId)).toEqual(before)

  const shellResult = await current.cli([
    'worktree', 'create', '--repo', `id:${repoId}`, '--name', 'goal-loop-shell-agent',
    '--base', 'main', '--no-parent', '--setup', 'skip', '--agent', 'shell'
  ])
  expect(shellResult.exitCode).not.toBe(0)
  const shellError = JSON.parse(shellResult.stdout) as { error?: { code?: string; message?: string } }
  expect(shellError.error).toEqual({
    code: 'invalid-params',
    message: 'agent must be an agent ID, not shell'
  })
  expect(await creationState(current, repoId)).toEqual(before)
}, 45_000)
