import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitCapabilityCache } from '../../shared/git-capability-cache'
import {
  executeHostedReviewBranchUpdate,
  HostedReviewConfirmedNotLandedError
} from '../../shared/fork-hosted-review-sitter/git-branch-update'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return { stdout: result.stdout, stderr: result.stderr }
}

async function commitFile(
  repo: string,
  name: string,
  contents: string,
  message: string
): Promise<string> {
  await execFileAsync('node', [
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(join(repo, name))}, ${JSON.stringify(contents)})`
  ])
  await git(repo, ['add', '--', name])
  await git(repo, ['commit', '-m', message])
  return (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()
}

function isPublicationPush(args: string[]): boolean {
  return args[0] === 'push' && args.some((arg) => arg.startsWith('--force-with-lease='))
}

describe('executeHostedReviewBranchUpdate', () => {
  let root: string
  let bare: string
  let review: string
  let producer: string
  let reviewHead: string
  let baseHead: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'quirky-sitter-update-'))
    bare = join(root, 'remote.git')
    review = join(root, 'review')
    producer = join(root, 'producer')
    await git(root, ['init', '--bare', bare])
    await git(root, ['clone', bare, producer])
    await git(producer, ['config', 'user.email', 'sitter@example.test'])
    await git(producer, ['config', 'user.name', 'Sitter Test'])
    await git(producer, ['switch', '-c', 'main'])
    await commitFile(producer, 'base.txt', 'base\n', 'base')
    await git(producer, ['push', '-u', 'origin', 'main'])
    await git(root, ['clone', '--branch', 'main', bare, review])
    await git(review, ['config', 'user.email', 'sitter@example.test'])
    await git(review, ['config', 'user.name', 'Sitter Test'])
    await git(review, ['switch', '-c', 'feature'])
    reviewHead = await commitFile(review, 'feature.txt', 'feature\n', 'feature')
    await git(review, ['push', '-u', 'origin', 'feature'])
    baseHead = await commitFile(producer, 'base.txt', 'base moved\n', 'move base')
    await git(producer, ['push', 'origin', 'main'])
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('merges the exact base and conditionally publishes the resulting head', async () => {
    const result = await executeHostedReviewBranchUpdate(
      (args) => git(review, args),
      new GitCapabilityCache(),
      {
        worktreePath: review,
        branch: 'feature',
        pushRemote: bare,
        baseRef: 'origin/main',
        expectedHeadSha: reviewHead,
        expectedBaseSha: baseHead,
        mode: 'merge-base-update'
      }
    )

    const remoteHead = (
      await git(review, ['ls-remote', '--heads', 'origin', 'refs/heads/feature'])
    ).stdout
      .trim()
      .split(/\s+/)[0]
    expect(remoteHead).toBe(result.resultingHeadSha)
    await expect(
      git(review, ['merge-base', '--is-ancestor', reviewHead, remoteHead!])
    ).resolves.toBeDefined()
    await expect(
      git(review, ['merge-base', '--is-ancestor', baseHead, remoteHead!])
    ).resolves.toBeDefined()
  })

  it('rejects a stale provider head before changing the worktree', async () => {
    await expect(
      executeHostedReviewBranchUpdate((args) => git(review, args), new GitCapabilityCache(), {
        worktreePath: review,
        branch: 'feature',
        pushRemote: bare,
        baseRef: 'origin/main',
        expectedHeadSha: baseHead,
        expectedBaseSha: baseHead,
        mode: 'merge-base-update'
      })
    ).rejects.toMatchObject({ effect: 'not-landed', reason: 'expected-state-mismatch' })
    await expect(git(review, ['rev-parse', 'HEAD'])).resolves.toMatchObject({
      stdout: `${reviewHead}\n`
    })
  })

  it('rewinds when the authority confirms a thrown push did not land', async () => {
    const dropped = new Error('transport dropped before push')
    await expect(
      executeHostedReviewBranchUpdate(
        (args) => (isPublicationPush(args) ? Promise.reject(dropped) : git(review, args)),
        new GitCapabilityCache(),
        {
          worktreePath: review,
          branch: 'feature',
          pushRemote: bare,
          baseRef: 'origin/main',
          expectedHeadSha: reviewHead,
          expectedBaseSha: baseHead,
          mode: 'merge-base-update'
        },
        undefined,
        (args) => git(review, args)
      )
    ).rejects.toBeInstanceOf(HostedReviewConfirmedNotLandedError)
    await expect(git(review, ['rev-parse', 'HEAD'])).resolves.toMatchObject({
      stdout: `${reviewHead}\n`
    })
    await expect(git(review, ['status', '--porcelain'])).resolves.toMatchObject({ stdout: '' })
  })

  it('accepts a thrown push when the authority has the resulting head', async () => {
    const dropped = new Error('transport dropped after push')
    const result = await executeHostedReviewBranchUpdate(
      async (args) => {
        const response = await git(review, args)
        if (isPublicationPush(args)) {
          throw dropped
        }
        return response
      },
      new GitCapabilityCache(),
      {
        worktreePath: review,
        branch: 'feature',
        pushRemote: bare,
        baseRef: 'origin/main',
        expectedHeadSha: reviewHead,
        expectedBaseSha: baseHead,
        mode: 'merge-base-update'
      },
      undefined,
      (args) => git(review, args)
    )

    const remoteHead = (
      await git(review, ['ls-remote', '--heads', bare, 'refs/heads/feature'])
    ).stdout
      .trim()
      .split(/\s+/)[0]
    expect(remoteHead).toBe(result.resultingHeadSha)
  })

  it('keeps a thrown push indeterminate when the authority has a third head', async () => {
    const dropped = new Error('transport dropped before push')
    await expect(
      executeHostedReviewBranchUpdate(
        async (args) => {
          if (isPublicationPush(args)) {
            await git(producer, ['push', '--force', bare, `${baseHead}:refs/heads/feature`])
            throw dropped
          }
          return git(review, args)
        },
        new GitCapabilityCache(),
        {
          worktreePath: review,
          branch: 'feature',
          pushRemote: bare,
          baseRef: 'origin/main',
          expectedHeadSha: reviewHead,
          expectedBaseSha: baseHead,
          mode: 'merge-base-update'
        },
        undefined,
        (args) => git(review, args)
      )
    ).rejects.toBe(dropped)
    await expect(git(review, ['rev-parse', 'HEAD'])).resolves.not.toMatchObject({
      stdout: `${reviewHead}\n`
    })
  })

  it('rejects a raced remote head with expected-state certainty', async () => {
    let movedRemote = false
    const racingGit = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      if (
        !movedRemote &&
        args[0] === 'push' &&
        args.some((arg) => arg.startsWith('--force-with-lease='))
      ) {
        movedRemote = true
        await git(producer, ['push', '--force', bare, `${baseHead}:refs/heads/feature`])
      }
      return git(review, args)
    }

    await expect(
      executeHostedReviewBranchUpdate(racingGit, new GitCapabilityCache(), {
        worktreePath: review,
        branch: 'feature',
        pushRemote: bare,
        baseRef: 'origin/main',
        expectedHeadSha: reviewHead,
        expectedBaseSha: baseHead,
        mode: 'merge-base-update'
      })
    ).rejects.toMatchObject({ effect: 'not-landed', reason: 'expected-state-mismatch' })
    await expect(git(review, ['rev-parse', 'HEAD'])).resolves.toMatchObject({
      stdout: `${reviewHead}\n`
    })
  })

  it('rejects a moved base before creating an update commit', async () => {
    await expect(
      executeHostedReviewBranchUpdate((args) => git(review, args), new GitCapabilityCache(), {
        worktreePath: review,
        branch: 'feature',
        pushRemote: bare,
        baseRef: 'origin/main',
        expectedHeadSha: reviewHead,
        expectedBaseSha: reviewHead,
        mode: 'merge-base-update'
      })
    ).rejects.toMatchObject({ effect: 'not-landed', reason: 'expected-state-mismatch' })
    await expect(git(review, ['rev-parse', 'HEAD'])).resolves.toMatchObject({
      stdout: `${reviewHead}\n`
    })
  })
})
