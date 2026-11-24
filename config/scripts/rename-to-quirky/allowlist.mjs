/**
 * Shared by rename.mjs and check-no-orca-strings.mjs: loads and validates
 * config/rename-allowlist.json, matches paths against its globs, and lists the
 * tracked text files both tools scan.
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dirname, '../../..')

export class UsageError extends Error {}

function requireStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new UsageError(`allowlist: ${name} must be an array of strings`)
  }
  return value
}

export function parseAllowlist(raw) {
  if (!raw || raw.version !== 1) {
    throw new UsageError('allowlist: version must be 1')
  }
  const creditLines = raw.creditLines ?? []
  if (
    !Array.isArray(creditLines) ||
    creditLines.some((c) => typeof c?.path !== 'string' || typeof c?.match !== 'string')
  ) {
    throw new UsageError('allowlist: creditLines must be an array of { path, match }')
  }
  return {
    skipPaths: requireStringArray(raw.skipPaths ?? [], 'skipPaths'),
    keepTokens: requireStringArray(raw.keepTokens ?? [], 'keepTokens'),
    creditLines
  }
}

export function loadAllowlist(file) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new UsageError(`cannot read allowlist ${file}: ${error.message}`)
  }
  return parseAllowlist(raw)
}

export function resolveAllowlistFile(root, override) {
  return override ? resolve(override) : join(root, 'config', 'rename-allowlist.json')
}

export function globToRegExp(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

export function createGlobMatcher(globs) {
  const patterns = globs.map(globToRegExp)
  return (path) => patterns.some((pattern) => pattern.test(path))
}

export function matchesAnyGlob(globs, path) {
  return createGlobMatcher(globs)(path)
}

export function listTrackedFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
    maxBuffer: 1 << 30
  }).toString('utf8')
  return [...new Set(out.split('\0').filter(Boolean))]
}

export function isRegularFile(absPath) {
  try {
    return lstatSync(absPath).isFile()
  } catch {
    return false
  }
}

/** Decodes a file as UTF-8 text, or returns null when it is binary or not losslessly decodable. */
export function readTextFile(absPath) {
  const buffer = readFileSync(absPath)
  if (buffer.subarray(0, 8192).includes(0)) {
    return null
  }
  const text = buffer.toString('utf8')
  return Buffer.from(text, 'utf8').equals(buffer) ? text : null
}
