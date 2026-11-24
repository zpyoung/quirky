#!/usr/bin/env node
/**
 * Extracts IPC channel names from src/**\/*.ts(x) (test files excluded) and
 * reports two sets:
 *   rendererWithoutMain     renderer/preload invoke|send|sendSync channels no
 *                           ipcMain.handle|handleOnce|on|once registers
 *   mainSendWithoutRenderer webContents.send channels no ipcRenderer.on|once
 *                           listens to
 *
 *   node config/scripts/check-ipc-channel-parity.mjs [--root <dir>] [--json]
 *        [--baseline <file>] [--apply-rename-mapping]
 *
 * A channel argument is a string literal (backticks without `${`), or a name
 * resolved through consts named `*_CHANNEL` / `*_CHANNELS` (string, object or
 * array values; `CONST`, `CONST.key` and `CONST['key']` forms; aliased imports).
 * Unresolvable arguments are ignored.
 *
 * Without --baseline: prints both sets (JSON with --json) and exits 0. With
 * --baseline <file> (same JSON shape): lists only mismatches absent from the
 * baseline and exits 1 if there are any. --apply-rename-mapping renames the
 * baseline's channel names with the generic mapping first.
 *
 * Exit codes: 0 ok, 1 new mismatches against the baseline, 2 bad arguments.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { REPO_ROOT, UsageError } from './rename-to-quirky/allowlist.mjs'
import { mapGeneric } from './rename-to-quirky/mapping.mjs'

const SET_NAMES = ['rendererWithoutMain', 'mainSendWithoutRenderer']

const STRING_LITERAL = String.raw`(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|` + '`([^`$\\\\\\n]*)`)'
const CHANNEL_NAME = /(?:^|_)CHANNELS?$/

const CALL_PATTERN = /\b(ipcMain|ipcRenderer|webContents)\s*\??\.\s*(\w+)\s*\(\s*/g

const KIND_BY_CALL = {
  'ipcMain.handle': 'mainHandle',
  'ipcMain.handleOnce': 'mainHandle',
  'ipcMain.on': 'mainHandle',
  'ipcMain.once': 'mainHandle',
  'ipcRenderer.invoke': 'rendererSend',
  'ipcRenderer.send': 'rendererSend',
  'ipcRenderer.sendSync': 'rendererSend',
  'ipcRenderer.on': 'rendererListen',
  'ipcRenderer.once': 'rendererListen',
  'webContents.send': 'mainSend'
}

function parseArgs(argv) {
  const options = { root: REPO_ROOT, json: false, baseline: null, applyRenameMapping: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') {
      options.json = true
    } else if (arg === '--apply-rename-mapping') {
      options.applyRenameMapping = true
    } else if (arg === '--root' || arg === '--baseline') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${arg} needs a value`)
      }
      options[arg.slice(2)] = value
    } else {
      throw new UsageError(`unknown argument: ${arg}`)
    }
  }
  return options
}

function listSourceFiles(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        listSourceFiles(abs, out)
      }
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(abs)
    }
  }
  return out.sort()
}

function stripCommentLines(source) {
  return source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line))
    .join('\n')
}

const literalValue = (match) => match.slice(1).find((group) => group !== undefined)

function extractStrings(text) {
  return [...text.matchAll(new RegExp(STRING_LITERAL, 'g'))].map(literalValue)
}

function balancedEnd(source, start, open, close) {
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) {
      depth++
    } else if (source[i] === close && --depth === 0) {
      return i
    }
  }
  return source.length - 1
}

/** Collects `const NAME_CHANNEL(S) = ...` definitions as { string } or { keys, values }. */
function collectConsts(source, defs) {
  const declaration = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/g
  for (const match of source.matchAll(declaration)) {
    const name = match[1]
    if (!CHANNEL_NAME.test(name)) {
      continue
    }
    const start = match.index + match[0].length
    const first = source[start]
    let def = null
    if (first === '{') {
      const body = source.slice(start, balancedEnd(source, start, '{', '}') + 1)
      const keys = new Map()
      const entry = new RegExp(String.raw`(?:^|[,{\s])(?:([A-Za-z_$][\w$]*)|'([^']+)'|"([^"]+)")\s*:\s*${STRING_LITERAL}`, 'g')
      for (const pair of body.matchAll(entry)) {
        keys.set(pair[1] ?? pair[2] ?? pair[3], literalValue(pair.slice(3)))
      }
      def = { keys, values: [...keys.values()] }
    } else if (first === '[') {
      const body = source.slice(start, balancedEnd(source, start, '[', ']') + 1)
      def = { keys: new Map(), values: extractStrings(body) }
    } else {
      const literal = source.slice(start).match(new RegExp(`^${STRING_LITERAL}`))
      if (literal) {
        def = { value: literalValue(literal), keys: new Map(), values: [literalValue(literal)] }
      }
    }
    if (def) {
      defs.set(name, [...(defs.get(name) ?? []), def])
    }
  }
}

function collectAliases(source) {
  const aliases = new Map()
  for (const block of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
    for (const specifier of block[1].split(',')) {
      const alias = specifier.trim().match(/^(?:type\s+)?([\w$]+)\s+as\s+([\w$]+)$/)
      if (alias) {
        aliases.set(alias[2], alias[1])
      }
    }
  }
  return aliases
}

function resolveChannels(argText, defs, aliases) {
  const literal = argText.match(new RegExp(`^${STRING_LITERAL}\\s*[,)]`))
  if (literal) {
    return [literalValue(literal)]
  }
  const reference = argText.match(
    /^([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*)|\s*\[\s*(?:'([^']+)'|"([^"]+)")\s*\])?\s*[,)]/
  )
  if (!reference) {
    return []
  }
  const name = aliases.get(reference[1]) ?? reference[1]
  const key = reference[2] ?? reference[3] ?? reference[4]
  const found = defs.get(name) ?? []
  if (key !== undefined) {
    return found.map((def) => def.keys.get(key)).filter((value) => value !== undefined)
  }
  return found.filter((def) => def.value !== undefined).map((def) => def.value)
}

function collectChannels(root) {
  const files = listSourceFiles(join(resolve(root), 'src')).map((file) => ({
    source: stripCommentLines(readFileSync(file, 'utf8'))
  }))
  const defs = new Map()
  for (const { source } of files) {
    collectConsts(source, defs)
  }

  const sets = { mainHandle: new Set(), rendererSend: new Set(), rendererListen: new Set(), mainSend: new Set() }
  for (const { source } of files) {
    const aliases = collectAliases(source)
    for (const call of source.matchAll(CALL_PATTERN)) {
      const kind = KIND_BY_CALL[`${call[1]}.${call[2]}`]
      if (!kind) {
        continue
      }
      const argText = source.slice(call.index + call[0].length, call.index + call[0].length + 300)
      for (const channel of resolveChannels(argText, defs, aliases)) {
        sets[kind].add(channel)
      }
    }
  }

  const sorted = (values) => [...values].sort()
  return {
    rendererWithoutMain: sorted([...sets.rendererSend].filter((c) => !sets.mainHandle.has(c))),
    mainSendWithoutRenderer: sorted([...sets.mainSend].filter((c) => !sets.rendererListen.has(c)))
  }
}

function loadBaseline(file, mapNames) {
  let raw
  try {
    raw = JSON.parse(readFileSync(resolve(file), 'utf8'))
  } catch (error) {
    throw new UsageError(`cannot read baseline ${file}: ${error.message}`)
  }
  const baseline = {}
  for (const name of SET_NAMES) {
    const list = raw[name] ?? []
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
      throw new UsageError(`baseline: ${name} must be an array of strings`)
    }
    baseline[name] = new Set(mapNames ? list.map(mapGeneric) : list)
  }
  return baseline
}

function formatSets(sets) {
  return SET_NAMES.map(
    (name) => `${name} (${sets[name].length})\n${sets[name].map((channel) => `  ${channel}`).join('\n')}`
  ).join('\n')
}

function main() {
  let options
  let result
  try {
    options = parseArgs(process.argv.slice(2))
    const current = collectChannels(options.root)
    result = current
    if (options.baseline) {
      const baseline = loadBaseline(options.baseline, options.applyRenameMapping)
      result = Object.fromEntries(
        SET_NAMES.map((name) => [name, current[name].filter((channel) => !baseline[name].has(channel))])
      )
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
  console.log(options.json ? JSON.stringify(result, null, 2) : formatSets(result))
  const hasMismatch = SET_NAMES.some((name) => result[name].length > 0)
  process.exit(options.baseline && hasMismatch ? 1 : 0)
}

main()
