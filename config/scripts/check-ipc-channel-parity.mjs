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
 * A channel argument is a string literal (backticks without `${`; escapes are
 * decoded), or a name resolved through consts named `*_CHANNEL` / `*_CHANNELS`
 * (string, object or array values; `CONST`, `CONST.key` and `CONST['key']`
 * forms). A name resolves through its own module's declarations and its actual
 * relative imports and re-exports (including `import { X as Y }`), never through
 * a same-named constant in another module. Calls inside comments, strings and
 * regex literals are ignored; unresolvable arguments are ignored.
 *
 * Without --baseline: prints both sets (JSON with --json) and exits 0. With
 * --baseline <file> (same JSON shape): lists only mismatches absent from the
 * baseline and exits 1 if there are any. --apply-rename-mapping renames the
 * baseline's channel names with the generic mapping first.
 *
 * Exit codes: 0 ok, 1 new mismatches against the baseline, 2 bad arguments or
 * an unreadable or empty src directory.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import { REPO_ROOT, UsageError } from './rename-to-quirky/allowlist.mjs'
import { mapGeneric } from './rename-to-quirky/mapping.mjs'

const SET_NAMES = ['rendererWithoutMain', 'mainSendWithoutRenderer']

const STRING_LITERAL =
  String.raw`(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|` + '`((?:[^`\\\\$\\n]|\\\\.|\\$(?!\\{))*)`)'
const CHANNEL_NAME = /(?:^|_)CHANNELS?$/
const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`

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

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'delete', 'void', 'throw', 'in', 'of', 'new', 'else', 'do', 'yield', 'await'
])

const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }

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
  } catch (error) {
    throw new UsageError(`cannot read source directory ${dir}: ${error.message}`)
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

function lineEnd(source, from) {
  const end = source.indexOf('\n', from)
  return end === -1 ? source.length : end
}

function quoteEnd(source, start) {
  const quote = source[start]
  let i = start + 1
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2
    } else if (source[i] === quote || source[i] === '\n') {
      return i
    } else {
      i++
    }
  }
  return source.length
}

function regexLiteralEnd(source, start) {
  let inClass = false
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i]
    if (char === '\\') {
      i++
    } else if (char === '\n') {
      return -1
    } else if (char === '[') {
      inClass = true
    } else if (char === ']') {
      inClass = false
    } else if (char === '/' && !inClass) {
      return i
    }
  }
  return -1
}

function startsRegexLiteral(chars, at) {
  let k = at - 1
  while (k >= 0 && /\s/.test(chars[k])) {
    k--
  }
  if (k < 0) {
    return true
  }
  if (/[\w$]/.test(chars[k])) {
    let from = k
    while (from > 0 && /[\w$]/.test(chars[from - 1])) {
      from--
    }
    return REGEX_PRECEDING_KEYWORDS.has(chars.slice(from, k + 1).join(''))
  }
  return !/[)\]'"`]/.test(chars[k])
}

/**
 * Scans TypeScript source once and returns two same-length views of it: `code`
 * with comments blanked, and `masked` with comments and the insides of string,
 * template and regex literals blanked too. Call sites are found in `masked` so
 * text inside literals never counts; arguments are read from `code`.
 */
function scanSource(source) {
  const code = source.split('')
  const masked = source.split('')
  const clear = (chars, from, to) => {
    for (let k = from; k < to; k++) {
      if (chars[k] !== '\n' && chars[k] !== '\r') {
        chars[k] = ' '
      }
    }
  }
  const frames = []
  let braces = 0
  let inTemplate = false
  let i = 0
  while (i < source.length) {
    const char = source[i]
    if (inTemplate) {
      if (char === '\\') {
        clear(masked, i, i + 2)
        i += 2
      } else if (char === '`') {
        inTemplate = false
        i++
      } else if (char === '$' && source[i + 1] === '{') {
        frames.push(braces)
        braces = 0
        inTemplate = false
        i += 2
      } else {
        clear(masked, i, i + 1)
        i++
      }
      continue
    }
    const next = source[i + 1]
    if (char === '/' && next === '/') {
      const end = lineEnd(source, i)
      clear(code, i, end)
      clear(masked, i, end)
      i = end
    } else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2)
      const end = close === -1 ? source.length : close + 2
      clear(code, i, end)
      clear(masked, i, end)
      i = end
    } else if (char === "'" || char === '"') {
      const close = quoteEnd(source, i)
      clear(masked, i + 1, close)
      i = source[close] === char ? close + 1 : close
    } else if (char === '`') {
      inTemplate = true
      i++
    } else if (char === '/' && startsRegexLiteral(code, i)) {
      const close = regexLiteralEnd(source, i)
      if (close === -1) {
        i++
        continue
      }
      clear(masked, i, close + 1)
      i = close + 1
      while (/[a-z]/.test(source[i] ?? '')) {
        i++
      }
    } else if (char === '{') {
      braces++
      i++
    } else if (char === '}') {
      if (braces === 0 && frames.length > 0) {
        braces = frames.pop()
        inTemplate = true
      } else if (braces > 0) {
        braces--
      }
      i++
    } else {
      i++
    }
  }
  return { code: code.join(''), masked: masked.join('') }
}

function decodeLiteral(raw) {
  return raw.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g,
    (whole, codePoint, unit, hex, lineBreak, char) => {
      if (lineBreak !== undefined) {
        return ''
      }
      const digits = codePoint ?? unit ?? hex
      if (digits !== undefined) {
        try {
          return String.fromCodePoint(parseInt(digits, 16))
        } catch {
          return whole
        }
      }
      return SIMPLE_ESCAPES[char] ?? char
    }
  )
}

function literalValue(match, firstGroup = 1) {
  const raw = match.slice(firstGroup, firstGroup + 3).find((group) => group !== undefined)
  return raw === undefined ? undefined : decodeLiteral(raw)
}

function extractStrings(text) {
  return [...text.matchAll(new RegExp(STRING_LITERAL, 'g'))].map((match) => literalValue(match))
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

/** Collects this module's own `const NAME_CHANNEL(S) = ...` declarations as { value } or { keys, values }. */
function collectConsts(view) {
  const defs = new Map()
  const declaration = new RegExp(String.raw`\bconst\s+(${IDENTIFIER})\s*(?::[^=\n]+)?=\s*`, 'g')
  for (const match of view.masked.matchAll(declaration)) {
    const name = match[1]
    if (!CHANNEL_NAME.test(name)) {
      continue
    }
    const start = match.index + match[0].length
    const first = view.masked[start]
    let def = null
    if (first === '{') {
      const body = view.code.slice(start, balancedEnd(view.masked, start, '{', '}') + 1)
      const keys = new Map()
      const entry = new RegExp(
        String.raw`(?:^|[,{\s])(?:(${IDENTIFIER})|'([^']+)'|"([^"]+)")\s*:\s*${STRING_LITERAL}`,
        'g'
      )
      for (const pair of body.matchAll(entry)) {
        keys.set(pair[1] ?? pair[2] ?? pair[3], literalValue(pair, 4))
      }
      def = { keys, values: [...keys.values()] }
    } else if (first === '[') {
      const body = view.code.slice(start, balancedEnd(view.masked, start, '[', ']') + 1)
      def = { keys: new Map(), values: extractStrings(body) }
    } else {
      const literal = view.code.slice(start).match(new RegExp(`^${STRING_LITERAL}`))
      if (literal) {
        const value = literalValue(literal)
        def = { value, keys: new Map(), values: [value] }
      }
    }
    if (def) {
      defs.set(name, [...(defs.get(name) ?? []), def])
    }
  }
  return defs
}

function resolveSpecifier(fromFile, specifier, fileSet) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return null
  }
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier))
  const stem = base.replace(/\.(?:m?js|jsx)$/, '')
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  if (stem !== base) {
    candidates.push(`${stem}.ts`, `${stem}.tsx`)
  }
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null
}

function parseSpecifierList(text) {
  const out = []
  for (const part of text.split(',')) {
    const trimmed = part.trim().replace(/^type\s+/, '')
    const pair = trimmed.match(new RegExp(String.raw`^(${IDENTIFIER})(?:\s+as\s+(${IDENTIFIER}))?$`))
    if (pair) {
      out.push({ imported: pair[1], local: pair[2] ?? pair[1] })
    }
  }
  return out
}

/** Reads the module's imports, re-exports and `export { a as b }` aliases. */
function collectBindings(file, view, fileSet) {
  const imports = new Map()
  const reExports = new Map()
  const localExports = new Map()
  const stars = []
  const specifierAfter = (end, quote) => {
    const close = view.masked.indexOf(quote, end)
    return close === -1 ? null : view.code.slice(end, close)
  }

  const named = /\b(import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*(?:(from)\s*(['"]))?/g
  for (const match of view.masked.matchAll(named)) {
    const [whole, keyword, body, from, quote] = match
    const list = parseSpecifierList(body)
    if (keyword === 'import' && from) {
      const target = resolveSpecifier(file, specifierAfter(match.index + whole.length, quote) ?? '', fileSet)
      for (const { imported, local } of list) {
        imports.set(local, { module: target, imported })
      }
    } else if (keyword === 'export' && from) {
      const target = resolveSpecifier(file, specifierAfter(match.index + whole.length, quote) ?? '', fileSet)
      for (const { imported, local } of list) {
        reExports.set(local, { module: target, name: imported })
      }
    } else if (keyword === 'export') {
      for (const { imported, local } of list) {
        localExports.set(local, imported)
      }
    }
  }
  for (const match of view.masked.matchAll(/\bexport\s*\*\s*from\s*(['"])/g)) {
    const target = resolveSpecifier(file, specifierAfter(match.index + match[0].length, match[1]) ?? '', fileSet)
    if (target) {
      stars.push(target)
    }
  }
  return { imports, reExports, localExports, stars }
}

/** Finds the declarations `name` refers to in `file`, following only that module's own imports and exports. */
function lookup(modules, file, name, seen = new Set()) {
  const id = `${file}#${name}`
  const mod = modules.get(file)
  if (!mod || seen.has(id)) {
    return []
  }
  seen.add(id)
  if (mod.defs.has(name)) {
    return mod.defs.get(name)
  }
  const imported = mod.imports.get(name)
  if (imported) {
    return imported.module ? lookup(modules, imported.module, imported.imported, seen) : []
  }
  if (mod.localExports.has(name)) {
    return lookup(modules, file, mod.localExports.get(name), seen)
  }
  const reExport = mod.reExports.get(name)
  if (reExport) {
    return reExport.module ? lookup(modules, reExport.module, reExport.name, seen) : []
  }
  for (const star of mod.stars) {
    const found = lookup(modules, star, name, seen)
    if (found.length > 0) {
      return found
    }
  }
  return []
}

function resolveChannels(argText, modules, file) {
  const literal = argText.match(new RegExp(`^${STRING_LITERAL}\\s*[,)]`))
  if (literal) {
    return [literalValue(literal)]
  }
  const reference = argText.match(
    new RegExp(
      String.raw`^(${IDENTIFIER})(?:\s*\.\s*(${IDENTIFIER})|\s*\[\s*(?:'([^']+)'|"([^"]+)")\s*\])?\s*[,)]`
    )
  )
  if (!reference) {
    return []
  }
  const key = reference[2] ?? reference[3] ?? reference[4]
  const found = lookup(modules, file, reference[1])
  if (key !== undefined) {
    return found.map((def) => def.keys.get(key)).filter((value) => value !== undefined)
  }
  return found.filter((def) => def.value !== undefined).map((def) => def.value)
}

function collectChannels(root) {
  const absRoot = resolve(root)
  const absFiles = listSourceFiles(join(absRoot, 'src'))
  if (absFiles.length === 0) {
    throw new UsageError(`no source files found under ${join(absRoot, 'src')}`)
  }
  const files = absFiles.map((abs) => relative(absRoot, abs).split(sep).join('/'))
  const fileSet = new Set(files)

  const views = new Map()
  for (const [index, abs] of absFiles.entries()) {
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch (error) {
      throw new UsageError(`cannot read ${abs}: ${error.message}`)
    }
    views.set(files[index], scanSource(text))
  }

  const modules = new Map()
  for (const [file, view] of views) {
    modules.set(file, { defs: collectConsts(view), ...collectBindings(file, view, fileSet) })
  }

  const sets = { mainHandle: new Set(), rendererSend: new Set(), rendererListen: new Set(), mainSend: new Set() }
  for (const [file, view] of views) {
    for (const call of view.masked.matchAll(CALL_PATTERN)) {
      const kind = KIND_BY_CALL[`${call[1]}.${call[2]}`]
      if (!kind) {
        continue
      }
      const argStart = call.index + call[0].length
      for (const channel of resolveChannels(view.code.slice(argStart, argStart + 300), modules, file)) {
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
