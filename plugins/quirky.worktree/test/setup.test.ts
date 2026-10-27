import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RpcErrorCode, type Session, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { call, commitFiles, failure, git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { testCliContext } from '../../quirky.repo/test/harness'
import { commands } from '../cli'
import { shellQuote } from '../src/daemon/hooks-run'
import { githubUser, makeProject, repoSet, startWorld, useGlobalGitConfig, type SessionMode, type World } from './fixtures/repos'

setDefaultTimeout(60_000)
const { scratch } = isolateGitConfig()
let w: World | undefined
beforeEach(() => useGlobalGitConfig(scratch, githubUser('zoe')))
afterEach(async () => {
  await w?.t.cleanup()
  w = undefined
})

async function startApi(sessions: SessionMode, project: Parameters<typeof makeProject>[1] = {}) {
  w = await startWorld(sessions)
  const dir = makeProject(join(scratch(), 'api'), project)
  const repo = await w.add(dir)
  return { ...w, dir, repo }
}

const create = (params: Record<string, unknown>) => call(w!.client, 'quirky.worktree/create', { repo: 'api', ...params }) as Promise<WorktreeCreateResult>
const sessionsOf = async (worktreeId: string) => (await call(w!.client, 'quirky.session/list', { worktree: worktreeId })) as Session[]
const pty = () => w!.t.h.pty

/** The runner a worktree's setup uses: inside its git dir, never part of the checkout. */
const runnerOf = (worktreePath: string) => resolve(worktreePath, git(worktreePath, 'rev-parse', '--git-path', 'quirky/setup-runner.sh'))

/** What the Setup terminal would do: run the runner under bash. */
const runRunner = (runner: string) => Bun.spawnSync(['/bin/bash', runner], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

async function cli(positionals: string[], flags: Record<string, string | boolean> = {}) {
  const { ctx, lines } = testCliContext(w!.client, { json: true })
  await commands.create!({ positionals, flags }, ctx)
  return JSON.parse(lines[0]!) as WorktreeCreateResult
}

describe('SC-29: setup runs in a background Setup terminal with the hook environment (CLI)', () => {
  test('the Setup session runs the runner, which writes the hook environment into the worktree', async () => {
    const { dir } = await startApi('real')
    await repoSet(w!.client, 'api', {
      setupPolicy: 'run-by-default',
      setupScript: 'echo "$QUIRKY_ROOT_PATH|$QUIRKY_WORKTREE_PATH|$QUIRKY_WORKSPACE_NAME|$ORCA_ROOT_PATH" > setup.txt'
    })
    const before = (await call(w!.client, 'ui.state')) as { layout: { view: unknown } }
    const result = await cli(['api', 'with-setup'])
    const path = join(w!.root, 'api', 'with-setup')
    expect(result.setup).toMatchObject({ ran: 'terminal' })
    expect(result.setup.sessionId).toMatch(/^s_/)
    expect(result.agentSessionId).toBeUndefined()

    const [session] = await sessionsOf(result.worktree.id)
    expect(session).toMatchObject({ id: result.setup.sessionId, title: 'Setup', agent: 'shell', worktreeId: result.worktree.id, cwd: path })
    const runner = runnerOf(path)
    const spawned = pty().requests.find((request) => request.type === 'create' && request.sessionId === session!.id)
    expect(spawned).toMatchObject({ type: 'create', cwd: path })
    expect(spawned!.type === 'create' && spawned!.argv[3]).toEndWith(`exec /bin/bash '${runner}'`)
    expect(statSync(runner).mode & 0o777).toBe(0o755)
    expect(runner.startsWith(join(dir, '.git'))).toBe(true)

    expect(runRunner(runner).exitCode).toBe(0)
    expect(readFileSync(join(path, 'setup.txt'), 'utf8')).toBe(`${dir}|${path}|with-setup|${dir}\n`)
    pty().exit(session!.id, 0)
    await waitForSession(session!.id, 'exited')
    expect(((await call(w!.client, 'quirky.session/get', { session: session!.id })) as Session).exitCode).toBe(0)
    expect(((await call(w!.client, 'ui.state')) as { layout: { view: unknown } }).layout.view).toEqual(before.layout.view)
  })

  test('every mirrored variable is exported, and a single quote in a path is escaped', async () => {
    w = await startWorld('real')
    const dir = makeProject(join(scratch(), "it's api"))
    await w.add(dir)
    const names = ['CONDUCTOR_ROOT_PATH', 'CONDUCTOR_WORKSPACE_NAME', 'CONDUCTOR_WORKSPACE_PATH', 'GHOSTX_ROOT_PATH', 'ORCA_ROOT_PATH', 'ORCA_WORKSPACE_NAME', 'ORCA_WORKTREE_PATH', 'QUIRKY_ROOT_PATH', 'QUIRKY_WORKSPACE_NAME', 'QUIRKY_WORKTREE_PATH']
    await repoSet(w.client, "it's api", { setupPolicy: 'run-by-default', setupScript: names.map((name) => `echo ${name}=\"$${name}\"`).join(' >> vars.txt; ') + ' >> vars.txt' })
    const result = (await call(w.client, 'quirky.worktree/create', { repo: "it's api", name: 'q' })) as WorktreeCreateResult
    const runner = runnerOf(result.worktree.path)
    const spawned = pty().requests.find((request) => request.type === 'create' && request.sessionId === result.setup.sessionId)
    const command = spawned!.type === 'create' ? spawned!.argv[3]! : ''
    expect(command).toEndWith(`exec /bin/bash ${shellQuote(runner)}`)
    expect(command).toContain("it'\\''s api")
    expect(Bun.spawnSync(['/bin/bash', '-c', command], { stdin: 'ignore' }).exitCode).toBe(0)
    const worktreePath = result.worktree.path
    expect(readFileSync(join(worktreePath, 'vars.txt'), 'utf8').trim().split('\n').sort()).toEqual([
      `CONDUCTOR_ROOT_PATH=${dir}`,
      `CONDUCTOR_WORKSPACE_NAME=q`,
      `CONDUCTOR_WORKSPACE_PATH=${worktreePath}`,
      `GHOSTX_ROOT_PATH=${dir}`,
      `ORCA_ROOT_PATH=${dir}`,
      `ORCA_WORKSPACE_NAME=q`,
      `ORCA_WORKTREE_PATH=${worktreePath}`,
      `QUIRKY_ROOT_PATH=${dir}`,
      `QUIRKY_WORKSPACE_NAME=q`,
      `QUIRKY_WORKTREE_PATH=${worktreePath}`
    ])
  })
})

async function waitForSession(id: string, status: string): Promise<Session> {
  const deadline = Date.now() + 5000
  for (;;) {
    const session = (await call(w!.client, 'quirky.session/get', { session: id })) as Session
    if (session.status === status) return session
    if (Date.now() > deadline) throw new Error(`session ${id} did not reach ${status}`)
    await Bun.sleep(20)
  }
}

describe('SC-30: "ask" with no setup choice creates nothing and says how to answer (CLI; Orca defect)', () => {
  test('the first create is refused with the reason, the second with --setup skip creates without a warning', async () => {
    const { dir } = await startApi('real')
    await repoSet(w!.client, 'api', { setupScript: 'echo hi' })
    const refused = await failure(cli(['api', 'asked']))
    expect(refused).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'Setup decision required for this repository; pass --setup run or --setup skip',
      data: { reason: 'setup-decision-required' }
    })
    expect(existsSync(join(w!.root, 'api', 'asked'))).toBe(false)
    expect(git(dir, 'branch', '--list', 'zoe/asked')).toBe('')

    const skipped = await cli(['api', 'asked'], { setup: 'skip' })
    expect(skipped).toMatchObject({ warnings: [], setup: { ran: 'skipped' } })
    expect(await sessionsOf(skipped.worktree.id)).toEqual([])
  })

  test('skip-by-default creates, runs nothing and warns how to run it', async () => {
    await startApi('real')
    await repoSet(w!.client, 'api', { setupScript: 'echo hi', setupPolicy: 'skip-by-default' })
    const made = await cli(['api', 'skipped'])
    const path = join(w!.root, 'api', 'skipped')
    expect(made.warnings).toEqual([`setup hook skipped for ${path}; pass --setup run to run it.`])
    expect(made.setup).toEqual({ ran: 'skipped' })
    expect(await sessionsOf(made.worktree.id)).toEqual([])
    const run = await cli(['api', 'forced'], { setup: 'run' })
    expect(run.setup.ran).toBe('terminal')
  })

  test('with no setup script the policy and --setup change nothing', async () => {
    await startApi('real')
    for (const flags of [{}, { setup: 'run' }, { setup: 'skip' }] as Record<string, string>[]) {
      const made = await cli(['api', `none-${Object.values(flags).join('') || 'x'}`], flags)
      expect(made).toMatchObject({ warnings: [], setup: { ran: 'none' } })
    }
  })
})

describe('SC-32: an untrusted shared script never runs from the CLI without consent (CLI; Orca defect)', () => {
  const quirkyYaml = (script: string) => `scripts:\n  setup: ${JSON.stringify(script)}\n`

  test('t1 and t3 are refused before any git work, t2 and t4 run it, t5 is refused when the script changed', async () => {
    const { dir } = await startApi('none', { files: { 'a.txt': 'one\n', 'quirky.yaml': quirkyYaml('touch ran.txt') } })
    await repoSet(w!.client, 'api', { setupPolicy: 'run-by-default' })
    const root = join(w!.root, 'api')

    const t1 = await failure(cli(['api', 't1']))
    expect(t1.code).toBe(RpcErrorCode.Conflict)
    expect(t1.message).toContain('touch ran.txt')
    expect(t1.message).toContain('--trust-setup')
    expect(t1.message).toContain('quirky repo trust-hooks api')
    expect(t1.data).toMatchObject({ reason: 'hooks-untrusted', kind: 'setup', source: 'quirky.yaml', script: 'touch ran.txt', changed: false })
    expect(t1.data.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(root, 't1'))).toBe(false)
    expect(git(dir, 'branch', '--list', 'zoe/t1')).toBe('')

    const t2 = await cli(['api', 't2'], { 'trust-setup': true })
    expect(t2.setup).toMatchObject({ ran: 'daemon', exitCode: 0, timedOut: false })
    expect(existsSync(join(root, 't2', 'ran.txt'))).toBe(true)

    expect((await failure(cli(['api', 't3']))).data).toMatchObject({ reason: 'hooks-untrusted' })
    expect(existsSync(join(root, 't3'))).toBe(false)

    await call(w!.client, 'quirky.repo/trustHooks', { repo: 'api' })
    const t4 = await cli(['api', 't4'])
    expect(t4.setup.ran).toBe('daemon')
    expect(existsSync(join(root, 't4', 'ran.txt'))).toBe(true)

    commitFiles(dir, { 'quirky.yaml': quirkyYaml('touch ran.txt; echo v2') })
    const t5 = await failure(cli(['api', 't5']))
    expect(t5.data).toMatchObject({ reason: 'hooks-untrusted', changed: true, script: 'touch ran.txt; echo v2' })
    expect(existsSync(join(root, 't5'))).toBe(false)
  })

  test('declining setup skips the trust check, and a local script never needs trust', async () => {
    await startApi('none', { files: { 'a.txt': 'one\n', 'quirky.yaml': quirkyYaml('touch ran.txt') } })
    const skipped = await cli(['api', 'declined'], { setup: 'skip' })
    expect(skipped.setup.ran).toBe('skipped')
    expect(existsSync(join(w!.root, 'api', 'declined', 'ran.txt'))).toBe(false)

    await repoSet(w!.client, 'api', { setupScript: 'touch local.txt', commandSource: 'local-only' })
    const local = await cli(['api', 'local'], { setup: 'run' })
    expect(local.setup.ran).toBe('daemon')
    expect(existsSync(join(w!.root, 'api', 'local', 'local.txt'))).toBe(true)
  })

  test('the script is read at the base, not at the checked-out branch', async () => {
    const { dir } = await startApi('none', { files: { 'a.txt': 'one\n' } })
    git(dir, 'checkout', '-q', '-b', 'topic')
    commitFiles(dir, { 'quirky.yaml': quirkyYaml('touch topic.txt') })
    git(dir, 'checkout', '-q', 'main')
    const made = await create({ name: 'on-main', setup: 'run' })
    expect(made.setup.ran).toBe('none')
    await expect(create({ name: 'on-topic', base: 'topic', setup: 'run' })).rejects.toMatchObject({ data: { reason: 'hooks-untrusted' } })
  })
})

describe('SC-32: the hooks gate reads the file at the branch that is checked out', () => {
  test('an existing branch carrying an untrusted script is refused, and an untrusted script on another branch is not read', async () => {
    const { dir } = await startApi('none', { files: { 'a.txt': 'one\n' } })
    git(dir, 'checkout', '-q', '-b', 'topic')
    commitFiles(dir, { 'quirky.yaml': 'scripts:\n  setup: touch topic.txt\n' })
    git(dir, 'checkout', '-q', 'main')
    const refused = await failure(create({ branch: 'topic', setup: 'run' }))
    expect(refused.data).toMatchObject({ reason: 'hooks-untrusted', script: 'touch topic.txt' })
    expect(existsSync(join(w!.root, 'api', 'topic'))).toBe(false)
    const trusted = await create({ branch: 'topic', setup: 'run', trustSetup: true })
    expect(trusted.setup).toMatchObject({ ran: 'daemon', exitCode: 0 })
    expect(existsSync(join(trusted.worktree.path, 'topic.txt'))).toBe(true)
  })
})

describe('SC-32: trusting from the error covers the commit the create read', () => {
  test('hooks-untrusted names the ref, and trusting at that ref lets the same create through', async () => {
    const { dir } = await startApi('none', { files: { 'a.txt': 'one\n' } })
    git(dir, 'checkout', '-q', '-b', 'topic')
    commitFiles(dir, { 'quirky.yaml': 'scripts:\n  setup: touch topic.txt\n' })
    git(dir, 'checkout', '-q', 'main')

    const refused = await failure(create({ branch: 'topic', setup: 'run' }))
    expect(refused.data).toMatchObject({ reason: 'hooks-untrusted' })
    const ref = (refused.data as { ref: string }).ref
    expect(ref).toBeTruthy()
    expect(refused.message).toContain(`--ref ${ref}`)

    await call(w!.client, 'quirky.repo/trustHooks', { repo: 'api', kind: 'setup', ref })
    const made = await create({ branch: 'topic', setup: 'run' })
    expect(made.setup).toMatchObject({ ran: 'daemon', exitCode: 0 })
  })
})

describe('setup in a folder workspace', () => {
  test('a folder project with a local setup script runs it in a Setup terminal at the folder', async () => {
    w = await startWorld('real')
    const notes = join(scratch(), 'notes')
    mkdirSync(notes, { recursive: true })
    const notesDir = realpathSync(notes)
    await call(w.client, 'quirky.repo/add', { path: notesDir, folder: true })
    await repoSet(w.client, 'notes', { setupPolicy: 'run-by-default', setupScript: 'echo "$QUIRKY_ROOT_PATH|$QUIRKY_WORKTREE_PATH" > setup.txt' })
    const made = (await call(w.client, 'quirky.worktree/create', { repo: 'notes', name: 'drafts' })) as WorktreeCreateResult
    expect(made.setup).toMatchObject({ ran: 'terminal' })
    const request = pty().requests.find((r) => r.type === 'create' && r.sessionId === made.setup.sessionId)
    expect(request).toMatchObject({ cwd: notesDir })
    const runner = (request!.type === 'create' ? request!.argv[3]! : '').match(/exec \/bin\/bash '(.*)'$/)![1]!
    expect(runner).toContain(join('plugin-data', 'quirky.worktree', 'runners', made.worktree.id))
    expect(runRunner(runner).exitCode).toBe(0)
    expect(readFileSync(join(notesDir, 'setup.txt'), 'utf8')).toBe(`${notesDir}|${notesDir}\n`)
  })

  test('a folder project that asks and has a script refuses a create with no choice', async () => {
    w = await startWorld('real')
    const notes = join(scratch(), 'notes2')
    mkdirSync(notes, { recursive: true })
    await call(w.client, 'quirky.repo/add', { path: realpathSync(notes), folder: true })
    await repoSet(w.client, 'notes2', { setupScript: 'true' })
    const refused = await failure(call(w.client, 'quirky.worktree/create', { repo: 'notes2', name: 'x' }))
    expect(refused.data).toMatchObject({ reason: 'setup-decision-required' })
    expect(((await call(w.client, 'quirky.worktree/list', { repo: 'notes2' })) as Worktree[]).map((worktree) => worktree.name)).toEqual(['notes2'])
  })
})

describe('SC-35: the command-source policy picks shared, local or both (CLI)', () => {
  test('unset means local, then shared-only, then both in that order', async () => {
    await startApi('none', { files: { 'a.txt': 'one\n', 'quirky.yaml': 'scripts:\n  setup: echo shared >> order.txt\n' } })
    await repoSet(w!.client, 'api', { setupPolicy: 'run-by-default', setupScript: 'echo local >> order.txt' })
    await call(w!.client, 'quirky.repo/trustHooks', { repo: 'api' })
    const orderOf = (name: string) => readFileSync(join(w!.root, 'api', name, 'order.txt'), 'utf8')

    await cli(['api', 'unset'])
    expect(orderOf('unset')).toBe('local\n')
    await repoSet(w!.client, 'api', { commandSource: 'shared-only' })
    await cli(['api', 'shared'])
    expect(orderOf('shared')).toBe('shared\n')
    await repoSet(w!.client, 'api', { commandSource: 'run-both' })
    await cli(['api', 'both'])
    expect(orderOf('both')).toBe('shared\nlocal\n')
  })
})

describe('SC-36: a failing setup leaves the worktree in place (CLI)', () => {
  test('the worktree is created and listed, and its Setup session exits with the script\'s code', async () => {
    await startApi('real')
    await repoSet(w!.client, 'api', { setupPolicy: 'run-by-default', setupScript: 'exit 3' })
    const made = await cli(['api', 'broken'])
    expect(made.setup.ran).toBe('terminal')
    expect(((await call(w!.client, 'quirky.worktree/list', { repo: 'api' })) as Worktree[]).map((worktree) => worktree.name)).toContain('broken')

    const runner = runnerOf(made.worktree.path)
    expect(runRunner(runner).exitCode).toBe(3)
    pty().exit(made.setup.sessionId!, 3)
    const exited = await waitForSession(made.setup.sessionId!, 'exited')
    expect(exited.exitCode).toBe(3)
  })

  test('a failing setup in the daemon is reported in the result and also leaves the worktree', async () => {
    await startApi('none')
    await repoSet(w!.client, 'api', { setupPolicy: 'run-by-default', setupScript: 'exit 3' })
    const made = await create({ name: 'broken' })
    expect(made.setup).toMatchObject({ ran: 'daemon', exitCode: 3, timedOut: false })
    expect(existsSync(made.worktree.path)).toBe(true)
  })
})

describe('SC-37: with sessions off, setup runs in the daemon (API)', () => {
  test('the result says so with exit code 0 and the script\'s effect is in the worktree', async () => {
    await startApi('none')
    await repoSet(w!.client, 'api', { setupPolicy: 'run-by-default', setupScript: 'echo hi > hi.txt' })
    const made = await create({ name: 'headless' })
    expect(made.setup).toEqual({ ran: 'daemon', exitCode: 0, timedOut: false })
    expect(readFileSync(join(made.worktree.path, 'hi.txt'), 'utf8')).toBe('hi\n')
  })

  test('a session plugin that fails for another reason is a warning, not a daemon run', async () => {
    await startApi('real')
    await repoSet(w!.client, 'api', { setupPolicy: 'run-by-default', setupScript: 'echo hi > hi.txt' })
    pty().failRequests('create', 'pty host is down')
    const made = await create({ name: 'nohost' })
    expect(made.setup).toEqual({ ran: 'none' })
    expect(made.warnings).toHaveLength(1)
    expect(made.warnings[0]).toContain('could not start the Setup terminal')
    expect(existsSync(join(made.worktree.path, 'hi.txt'))).toBe(false)
  })
})

describe('SC-38: a create can start an agent, after setup when the project says to wait (API)', () => {
  const agentSessions = async (worktreeId: string) => (await sessionsOf(worktreeId)).filter((session) => session.agent === 'claude')

  test('wait-for-setup: the create returns at once with the Setup session and a pending agent, which starts once the Setup exits', async () => {
    await startApi('real')
    await repoSet(w!.client, 'api', { setupPolicy: 'run-by-default', setupScript: 'sleep 2', agentStartup: 'wait-for-setup' })
    const made = await create({ name: 'agented', agent: 'claude', prompt: 'fix the tests' })
    expect(made.setup.ran).toBe('terminal')
    expect(made.agentPending).toBe(true)
    expect(made.agentSessionId).toBeUndefined()
    expect((await sessionsOf(made.worktree.id)).map((session) => session.title)).toEqual(['Setup'])

    pty().exit(made.setup.sessionId!, 0)
    const started = await pollFor(async () => (await agentSessions(made.worktree.id))[0])
    expect(started).toMatchObject({ agent: 'claude', worktreeId: made.worktree.id })
    const request = pty().requests.find((r) => r.type === 'create' && r.sessionId === started.id)
    expect(request!.type === 'create' && request!.argv.join(' ')).toContain('fix the tests')
    await Bun.sleep(150)
    expect(await agentSessions(made.worktree.id)).toHaveLength(1)
  })

  test('the agent starts when the Setup fails, and when the Setup session is closed instead', async () => {
    await startApi('real')
    await repoSet(w!.client, 'api', { setupPolicy: 'run-by-default', setupScript: 'exit 1', agentStartup: 'wait-for-setup' })
    const failed = await create({ name: 'failed', agent: 'claude' })
    pty().exit(failed.setup.sessionId!, 1)
    await pollFor(async () => (await agentSessions(failed.worktree.id))[0])

    const closed = await create({ name: 'closed', agent: 'claude' })
    await call(w!.client, 'quirky.session/close', { session: closed.setup.sessionId! })
    await pollFor(async () => (await agentSessions(closed.worktree.id))[0])
    expect(await agentSessions(closed.worktree.id)).toHaveLength(1)
  })

  test('the Setup exiting before the create returns still starts the agent exactly once', async () => {
    await startApi('real')
    await repoSet(w!.client, 'api', { setupPolicy: 'run-by-default', setupScript: 'true', agentStartup: 'wait-for-setup' })
    for (let round = 0; round < 4; round++) {
      const seen = pty().requests.length
      const stopper = (async () => {
        const request = await pollFor(async () => pty().requests.slice(seen).find((r) => r.type === 'create' && r.argv.join(' ').includes('setup-runner')))
        pty().exit((request as { sessionId: string }).sessionId, 0)
      })()
      const made = await create({ name: `fast-${round}`, agent: 'claude' })
      await stopper
      await pollFor(async () => (await agentSessions(made.worktree.id))[0])
      await Bun.sleep(200)
      expect(await agentSessions(made.worktree.id)).toHaveLength(1)
    }
  })

  test('start-immediately names both sessions in the result', async () => {
    await startApi('real')
    await repoSet(w!.client, 'api', { setupPolicy: 'run-by-default', setupScript: 'sleep 2', agentStartup: 'start-immediately' })
    const made = await create({ name: 'both', agent: 'claude', prompt: 'go' })
    expect(made.setup.ran).toBe('terminal')
    expect(made.agentPending).toBeUndefined()
    const sessions = await sessionsOf(made.worktree.id)
    expect(sessions.map((session) => session.id).sort()).toEqual([made.setup.sessionId!, made.agentSessionId!].sort())
  })

  test('with no setup to wait for the agent starts at once, and a failing start is a warning', async () => {
    await startApi('real')
    await repoSet(w!.client, 'api', { agentStartup: 'wait-for-setup' })
    const direct = await create({ name: 'direct', agent: 'claude' })
    expect(direct.setup.ran).toBe('none')
    expect(direct.agentSessionId).toBeTruthy()
    expect(direct.agentPending).toBeUndefined()

    pty().failRequests('create', 'no pty')
    const broken = await create({ name: 'broken', agent: 'claude' })
    expect(broken.agentSessionId).toBeUndefined()
    expect(broken.warnings.join('\n')).toContain('could not start claude')
  })

  test('with sessions off the agent cannot start and the create says so', async () => {
    await startApi('none')
    const made = await create({ name: 'nosessions', agent: 'claude' })
    expect(made.warnings.join('\n')).toContain('could not start claude')
    expect(made.worktree.name).toBe('nosessions')
  })

  test('a daemon restart drops a pending agent without creating it', async () => {
    const { t } = await startApi('real')
    await repoSet(w!.client, 'api', { setupPolicy: 'run-by-default', setupScript: 'true', agentStartup: 'wait-for-setup' })
    const made = await create({ name: 'lost', agent: 'claude' })
    expect(made.agentPending).toBe(true)
    const restarted = await t.restart()
    await Bun.sleep(200)
    const sessions = (await call(restarted.client, 'quirky.session/list', { worktree: made.worktree.id })) as Session[]
    expect(sessions.filter((session) => session.agent === 'claude')).toEqual([])
  })
})

async function pollFor<T>(check: () => Promise<T | undefined | null | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('pollFor timed out')
    await Bun.sleep(15)
  }
}

describe('SC-39: .worktreeinclude copies gitignored files and shared directories are linked (CLI)', () => {
  async function startCarry() {
    const started = await startApi('none', {
      ignored: ['.env*', 'cache/'],
      files: {
        'README.md': 'readme\n',
        'quirky.yaml': 'worktree:\n  sharedDirectories:\n    - cache\n    - docs\n    - ../out\n'
      }
    })
    const { dir } = started
    mkdirSync(join(dir, 'docs'))
    commitFiles(dir, { 'docs/guide.md': 'guide\n' })
    writeFileSync(join(dir, '.env'), 'SECRET=1\n')
    writeFileSync(join(dir, '.env.local'), 'LOCAL=1\n', { mode: 0o600 })
    mkdirSync(join(dir, 'cache'))
    writeFileSync(join(dir, 'cache', 'big.bin'), 'cached\n')
    writeFileSync(join(dir, '.worktreeinclude'), '.env*\nREADME.md\n.git\n')
    return started
  }

  test('ignored files named by .worktreeinclude are copied, shared directories linked, the rest skipped with warnings', async () => {
    const { dir } = await startCarry()
    const made = await cli(['api', 'carried'])
    const path = made.worktree.path
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(readFileSync(join(path, '.env.local'), 'utf8')).toBe('LOCAL=1\n')
    expect(statSync(join(path, '.env.local')).mode & 0o777).toBe(0o600)
    expect(git(path, 'ls-files', 'README.md')).toBe('README.md')
    expect(git(path, 'status', '--porcelain', '--', 'README.md')).toBe('')
    expect(readFileSync(join(path, '.git'), 'utf8')).toStartWith('gitdir: ')
    expect(lstatSync(join(path, 'cache')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(path, 'cache'))).toBe(join(dir, 'cache'))
    expect(lstatSync(join(path, 'docs')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(path, '..', '..', 'out'))).toBe(false)

    expect(made.warnings).toHaveLength(2)
    expect(made.warnings.find((warning) => warning.includes('"docs"'))).toContain('not ignored')
    expect(made.warnings.find((warning) => warning.includes('"../out"'))).toContain('outside')
  })

  test('the text output lists each warning on its own line after the record', async () => {
    await startCarry()
    const { ctx, lines } = testCliContext(w!.client)
    await commands.create!({ positionals: ['api', 'texty'], flags: {} }, ctx)
    const rows = lines[0]!.split('\n')
    expect(rows.slice(0, 4).map((row) => row.split(':')[0])).toEqual(['id', 'name', 'branch', 'path'])
    expect(rows.slice(4)).toHaveLength(2)
  })

  test('a file that already exists in the new worktree is not overwritten', async () => {
    const { dir } = await startApi('none', { ignored: ['notes.txt'], files: { 'a.txt': 'one\n' } })
    writeFileSync(join(dir, 'notes.txt'), 'primary\n')
    writeFileSync(join(dir, '.worktreeinclude'), 'notes.txt\n')
    const made = await create({ name: 'kept' })
    expect(readFileSync(join(made.worktree.path, 'notes.txt'), 'utf8')).toBe('primary\n')
  })
})
