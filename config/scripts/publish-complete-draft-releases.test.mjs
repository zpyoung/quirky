import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isTagBuiltFromCurrentRef,
  isReleaseCutDraft,
  publishCompleteDraftReleases,
  writeGithubOutputs
} from './publish-complete-draft-releases.mjs'

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function withGitRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-draft-release-'))
  try {
    git(dir, ['init', '--initial-branch=main'])
    git(dir, ['config', 'user.name', 'Test Bot'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function commit(cwd, message) {
  git(cwd, ['commit', '--allow-empty', '-m', message])
}

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body)))
  }
}

describe('isReleaseCutDraft', () => {
  const release = {
    draft: true,
    author: { login: 'github-actions[bot]' }
  }

  it.each(['v1.4.2-rc.7', 'v1.4.2-rc.7.zy01', 'v1.4.2-rc.7.zy99'])(
    'accepts release-cut draft tag %s',
    (tag_name) => {
      expect(isReleaseCutDraft({ ...release, tag_name })).toBe(true)
    }
  )

  it.each([
    'mobile-v0.0.7',
    'v1.4.2',
    'v1.4.2-rc.7.zy1',
    'v1.4.2-rc.7.zy001',
    'v1.4.2-rc.7.zyAA',
    'v1.4.2-rc.7-zy01',
    'v1.4.2-rc.7.zy01.extra'
  ])('rejects malformed release-cut draft tag %s', (tag_name) => {
    expect(isReleaseCutDraft({ ...release, tag_name })).toBe(false)
  })

  it('rejects non-bot and non-draft releases with fork tags', () => {
    expect(
      isReleaseCutDraft({
        ...release,
        tag_name: 'v1.4.2-rc.7.zy01',
        author: { login: 'octocat' }
      })
    ).toBe(false)
    expect(
      isReleaseCutDraft({
        ...release,
        draft: false,
        tag_name: 'v1.4.2-rc.7.zy01'
      })
    ).toBe(false)
  })
})

describe('isTagBuiltFromCurrentRef', () => {
  it('accepts a tag on the current release commit', () => {
    withGitRepo((repo) => {
      commit(repo, 'initial')
      commit(repo, 'release: v1.4.36-rc.6')
      git(repo, ['tag', 'v1.4.36-rc.6'])

      expect(isTagBuiltFromCurrentRef('v1.4.36-rc.6', { cwd: repo })).toBe(true)
    })
  })

  it('accepts a tag whose release commit is built from the current ref', () => {
    withGitRepo((repo) => {
      commit(repo, 'initial')
      const source = git(repo, ['rev-parse', 'HEAD'])
      commit(repo, 'release: v1.4.36-rc.6')
      git(repo, ['tag', 'v1.4.36-rc.6'])
      git(repo, ['checkout', source])

      expect(isTagBuiltFromCurrentRef('v1.4.36-rc.6', { cwd: repo })).toBe(true)
    })
  })

  it('rejects a stale tag when the current ref has moved on', () => {
    withGitRepo((repo) => {
      commit(repo, 'initial')
      commit(repo, 'release: v1.4.36-rc.6')
      git(repo, ['tag', 'v1.4.36-rc.6'])
      commit(repo, 'fix: release packaging')

      expect(isTagBuiltFromCurrentRef('v1.4.36-rc.6', { cwd: repo })).toBe(false)
    })
  })
})

describe('publishCompleteDraftReleases', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['upstream', 'v1.4.2-rc.7', 'v1.4.2-rc.8'],
    ['fork', 'v1.4.2-rc.7.zy01', 'v1.4.2-rc.8.zy01']
  ])(
    'publishes complete %s release-cut drafts and skips incomplete ones',
    async (_kind, completeTag, incompleteTag) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([
            {
              id: 7,
              draft: true,
              tag_name: completeTag,
              created_at: '2026-05-15T07:31:19Z',
              author: { login: 'github-actions[bot]' }
            },
            {
              id: 8,
              draft: true,
              tag_name: incompleteTag,
              created_at: '2026-05-15T10:51:57Z',
              author: { login: 'github-actions[bot]' }
            }
          ])
        )
        .mockResolvedValueOnce(jsonResponse({ tag_name: completeTag, draft: false }))
      const verifyReleaseAssets = vi.fn(async ({ tag }) => {
        if (tag === incompleteTag) {
          throw new Error(`Release ${incompleteTag} is missing required assets.`)
        }
      })
      const log = vi.fn()

      const result = await publishCompleteDraftReleases({
        repo: 'stablyai/orca',
        token: 'token',
        fetchImpl,
        verifyReleaseAssets,
        isDraftBuiltFromCurrentRef: vi.fn(async () => true),
        log
      })

      expect(result).toEqual({
        published: [completeTag],
        skipped: [
          {
            tag: incompleteTag,
            reason: `Release ${incompleteTag} is missing required assets.`
          }
        ]
      })
      expect(fetchImpl).toHaveBeenLastCalledWith(
        'https://api.github.com/repos/stablyai/orca/releases/7',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ draft: false, prerelease: true })
        })
      )
    }
  )

  it.each([
    ['upstream', 'v1.4.2-rc.7'],
    ['fork', 'v1.4.2-rc.7.zy01']
  ])('skips stale complete %s drafts before publishing', async (_kind, tag) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse([
        {
          id: 7,
          draft: true,
          tag_name: tag,
          created_at: '2026-05-15T07:31:19Z',
          author: { login: 'github-actions[bot]' }
        }
      ])
    )
    const verifyReleaseAssets = vi.fn()
    const log = vi.fn()

    const result = await publishCompleteDraftReleases({
      repo: 'stablyai/orca',
      token: 'token',
      fetchImpl,
      verifyReleaseAssets,
      isDraftBuiltFromCurrentRef: vi.fn(async () => false),
      log
    })

    expect(result).toEqual({
      published: [],
      skipped: [{ tag, reason: 'tag is not built from the current release ref' }]
    })
    expect(verifyReleaseAssets).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps an artifact-less fork draft private with the real asset verifier', async () => {
    const tag = 'v1.4.2-rc.7.zy01'
    const release = {
      id: 7,
      draft: true,
      prerelease: true,
      tag_name: tag,
      assets: [],
      created_at: '2026-05-15T07:31:19Z',
      author: { login: 'github-actions[bot]' }
    }
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse([release]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse([release])))

    const result = await publishCompleteDraftReleases({
      repo: 'zpyoung/quirky',
      token: 'token',
      fetchImpl,
      isDraftBuiltFromCurrentRef: vi.fn(async () => true),
      log: vi.fn()
    })

    expect(result).toEqual({
      published: [],
      skipped: [{ tag, reason: `Release ${tag} is missing required assets.` }]
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('writeGithubOutputs', () => {
  it('writes count outputs for workflow conditions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-release-outputs-'))
    const outputPath = join(dir, 'output')
    try {
      writeGithubOutputs(
        {
          published: ['v1.4.2-rc.7'],
          skipped: [{ tag: 'v1.4.2-rc.8', reason: 'missing assets' }]
        },
        outputPath
      )

      expect(readFileSync(outputPath, 'utf8')).toBe(
        `${[
          'published_count=1',
          'skipped_count=1',
          'latest_published_tag=v1.4.2-rc.7',
          'published_tags=v1.4.2-rc.7',
          'skipped_tags=v1.4.2-rc.8'
        ].join('\n')}\n`
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
