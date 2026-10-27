import { describe, expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'
import { classifyCommitFailure, classifyPushFailure, isPushHookFailure, stripAnsi } from '../src/failure'
import { runGit } from '../src/run'

const { scratch } = isolateGitConfig()

describe('stripAnsi', () => {
  test('removes colour codes and control characters but keeps newlines and tabs', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m\r\nok\tdone\u0007\u0000')).toBe('red\nok\tdone')
  })

  test('removes OSC sequences', () => {
    expect(stripAnsi('a\u001b]0;title\u0007b')).toBe('ab')
  })
})

describe('classifyCommitFailure', () => {
  const cases: Array<[string, string, 'lint' | 'hook' | 'failed', string]> = [
    ['eslint', 'eslint found 2 problems', 'lint', 'Lint failed during commit.'],
    ['oxlint', 'oxlint: 1 error', 'lint', 'Lint failed during commit.'],
    ['lint-staged', 'lint-staged failed', 'lint', 'Lint failed during commit.'],
    ['bare lint', 'Running lint...\nfailed', 'lint', 'Lint failed during commit.'],
    ['case-insensitive', 'ESLint exploded', 'lint', 'Lint failed during commit.'],
    ['pre-commit', 'pre-commit: missing header', 'hook', 'Pre-commit hook failed.'],
    ['precommit', 'precommit check failed', 'hook', 'Pre-commit hook failed.'],
    ['husky', 'husky - script failed', 'hook', 'Pre-commit hook failed.'],
    ['other', 'fatal: unable to auto-detect email address', 'failed', 'fatal: unable to auto-detect email address']
  ]
  for (const [name, output, reason, summary] of cases) {
    test(name, () => {
      const result = classifyCommitFailure(output)
      expect(result.reason).toBe(reason)
      expect(result.summary).toBe(summary)
      expect(result.output).toBe(output)
    })
  }

  test('lint wins over hook when both appear', () => {
    expect(classifyCommitFailure('husky > pre-commit\neslint failed').reason).toBe('lint')
  })

  test('words that merely contain lint do not count', () => {
    expect(classifyCommitFailure('splinter broke').reason).toBe('failed')
  })

  test('the first meaningful line skips blanks and npm noise when another line exists', () => {
    const out = '\n  \nnpm warn config global\nnpm notice new version\nhusky - DEPRECATED\n\nerror: nothing to commit'
    const result = classifyCommitFailure(out)
    expect(result.reason).toBe('hook')
    const plain = classifyCommitFailure('\nnpm warn something odd\nerror: cannot lock ref')
    expect(plain.summary).toBe('error: cannot lock ref')
  })

  test('falls back to the low-signal line when it is the only one, and to a default when empty', () => {
    expect(classifyCommitFailure('npm warn only this').summary).toBe('npm warn only this')
    expect(classifyCommitFailure('  \n\n').summary).toBe('Commit failed.')
    expect(classifyCommitFailure('').reason).toBe('failed')
  })

  test('strips ANSI before classifying and in the output', () => {
    const result = classifyCommitFailure('\u001b[31meslint\u001b[0m failed')
    expect(result.reason).toBe('lint')
    expect(result.output).toBe('eslint failed')
  })

  test('scans only the first 64 KiB', () => {
    const out = `${'x'.repeat(70 * 1024)}\neslint failed`
    const result = classifyCommitFailure(out)
    expect(result.reason).toBe('failed')
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(64 * 1024)
  })

  test('classifies the output of a real failing pre-commit hook', async () => {
    const repo = makeRepo(scratch())
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "eslint found 2 problems"\nexit 1\n')
    chmodSync(hook, 0o755)
    writeFileSync(join(repo, 'b.txt'), 'x\n')
    git(repo, 'add', '.')
    const r = await runGit(repo, ['commit', '-m', 'Add math'])
    expect(r.exitCode).not.toBe(0)
    const lint = classifyCommitFailure(r.stderr + new TextDecoder().decode(r.stdout))
    expect(lint.reason).toBe('lint')
    expect(lint.summary).toBe('Lint failed during commit.')
    expect(lint.output).toContain('eslint found 2 problems')

    writeFileSync(hook, '#!/bin/sh\necho "pre-commit: missing header"\nexit 1\n')
    const r2 = await runGit(repo, ['commit', '-m', 'Add math'])
    const plain = classifyCommitFailure(r2.stderr + new TextDecoder().decode(r2.stdout))
    expect(plain.reason).toBe('hook')
    expect(plain.summary).toBe('Pre-commit hook failed.')
  })
})

describe('isPushHookFailure', () => {
  const hookCases = [
    'remote: error: hook declined to update refs/heads/x\n ! [remote rejected] HEAD -> x (hook declined)',
    'running pre-push checks\nerror: failed to push some refs to origin',
    'lint-staged failed\nerror: failed to push some refs to \'/tmp/origin.git\'',
    'husky - pre-push script failed (code 1)\nerror: failed to push some refs',
    'lefthook: checks failed\nerror: failed to push some refs'
  ]
  for (const text of hookCases) test(`true: ${text.split('\n')[0]}`, () => expect(isPushHookFailure(text)).toBe(true))

  const notHook = [
    'fatal: Authentication failed for \'https://x/y.git\'',
    'git@host: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    ' ! [rejected] HEAD -> main (non-fast-forward)\nerror: failed to push some refs to x\nhint: pre-push hint',
    ' ! [rejected] HEAD -> main (fetch first)\nerror: failed to push some refs',
    'remote: error: GH006: Protected branch update failed\nerror: failed to push some refs\nhusky',
    'fatal: Could not resolve host: example.invalid\nlint-staged\nerror: failed to push some refs',
    'fatal: unable to access \'https://x/\': Failed to connect\nerror: failed to push some refs',
    'error: failed to push all needed submodules\nerror: failed to push some refs\nhusky',
    'everything is fine'
  ]
  for (const text of notHook) test(`false: ${text.split('\n')[0]}`, () => expect(isPushHookFailure(text)).toBe(false))

  test('husky text without a push context is not a push hook failure', () => {
    expect(isPushHookFailure('husky - script failed')).toBe(false)
  })
})

describe('classifyPushFailure', () => {
  test('lint text gives the lint summary', () => {
    const r = classifyPushFailure('lint-staged failed\nerror: failed to push some refs')
    expect(r).toEqual({
      reason: 'lint',
      summary: 'Lint failed during push.',
      output: 'lint-staged failed\nerror: failed to push some refs'
    })
  })

  test('other hook text gives the pre-push summary', () => {
    const r = classifyPushFailure('\u001b[1mpre-push: tests failed\u001b[0m\nerror: failed to push some refs')
    expect(r.reason).toBe('hook')
    expect(r.summary).toBe('Pre-push hook failed.')
    expect(r.output).toBe('pre-push: tests failed\nerror: failed to push some refs')
  })
})
