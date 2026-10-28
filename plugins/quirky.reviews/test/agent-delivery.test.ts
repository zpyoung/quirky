import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startAgentsE2E, type E2E } from '../../quirky.agents/test/support/e2e'
import { checksFixtureState, checksGhSource, checksReview } from './checks-fixture'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}

test('queued review comments resolve only after a real ready-agent process receives the prompt once', async () => {
  const fixture = mkdtempSync('/tmp/qrv-delivery-')
  const statePath = join(fixture, 'state.json')
  mkdirSync(join(fixture, 'gh-config'))
  writeFileSync(statePath, JSON.stringify(checksFixtureState([checksReview()], { threads: [{ id: 'thread-1', commentId: 77, body: 'Please fix this.' }] })))
  let h: E2E | undefined
  try {
    h = await startAgentsE2E({
      fakes: { claude: { raw: true, exitAfterMs: 30, exitCode: 1 } },
      extraEnv: { QUIRKY_TEST_FIXTURE_DIR: fixture, GH_CONFIG_DIR: join(fixture, 'gh-config'), GH_TOKEN: 'fixture-token', GITHUB_TOKEN: 'fixture-token' }
    })
    const gh = join(h.fakebin, 'gh')
    writeFileSync(gh, `#!${process.execPath}\nprocess.env.QUIRKY_TEST_GH_INPUT = await new Response(Bun.stdin.stream()).text()\n${checksGhSource}`)
    chmodSync(gh, 0o755)
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: h!.repo, env: { PATH: '/usr/bin:/bin', HOME: h!.userHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
      return new TextDecoder().decode(result.stdout).trim()
    }
    git('switch', '--quiet', '-c', 'feature')
    git('remote', 'add', 'origin', 'https://github.com/test-owner/test-repo.git')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('update-ref', 'refs/remotes/origin/feature', 'HEAD')
    git('config', 'branch.feature.remote', 'origin')
    git('config', 'branch.feature.merge', 'refs/heads/feature')
    const worktree = object(await h.call('quirky.worktree/resolve', { selector: `path:${h.repo}` }))
    if (typeof worktree.id !== 'string') throw new Error('Registered worktree was not returned')
    const target = { worktree: worktree.id, number: 12 }
    await h.call('quirky.reviews/checksLink', target)
    await h.call('quirky.reviews/checksRefresh', { worktree: worktree.id, force: true })
    await h.call('quirky.reviews/detailQueueComment', { ...target, surface: 'checks', commentId: '77', queued: true })
    const prompt = 'Resolve the selected review comments.'
    await h.call('quirky.reviews/checksSetAgentDialog', { ...target, action: 'comments', prompt })
    const failed = object(await h.call('quirky.reviews/checksLaunchAgent', { worktree: worktree.id, agent: 'claude' }))
    expect(failed.delivered).toBe(false)
    expect(object(object(await h.call('quirky.reviews/state')).checks).queuedComments).toEqual(['77'])
    expect(object(JSON.parse(readFileSync(statePath, 'utf8')) as unknown).resolvedThreads).toEqual([])

    h.addFake('claude', { raw: true, steps: [{ afterMs: 50, write: '\u001b[?2004h' }, { afterMs: 10, write: '> \r\n' }] })
    await h.call('quirky.agents/refresh')
    const delivered = object(await h.call('quirky.reviews/checksLaunchAgent', { worktree: worktree.id, agent: 'claude' }))
    expect(delivered.delivered, JSON.stringify(delivered)).toBe(true)
    expect(object(JSON.parse(readFileSync(statePath, 'utf8')) as unknown).resolvedThreads).toEqual(['thread-1'])
    expect(object(object(await h.call('quirky.reviews/state')).checks).queuedComments).toEqual([])
    const input = h.fakeLog('claude').flatMap(event => event.type === 'input' ? [Buffer.from(event.b64, 'base64').toString('utf8')] : []).join('')
    expect(input.split(prompt).length - 1).toBe(1)
    expect(input).toContain('\u001b[200~' + prompt + '\u001b[201~')
  } finally {
    try { await h?.cleanup() } finally { rmSync(fixture, { recursive: true, force: true }) }
  }
}, 60_000)
