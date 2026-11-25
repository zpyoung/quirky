#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const checks = [
  {
    name: 'macOS Swift renderer/provider tests',
    command: 'swift',
    args: ['test', '--package-path', 'native/computer-use-macos'],
    enabled: process.platform === 'darwin'
  },
  {
    name: 'native provider argument guardrails',
    run: verifyNativeArgumentGuardrails,
    enabled: true
  },
  {
    name: 'macOS helper app bundle and signature',
    run: verifyMacOSHelperApp,
    enabled: process.platform === 'darwin'
  }
]

let failed = false
for (const check of checks) {
  if (!check.enabled) {
    console.log(`[computer-native] skip ${check.name}`)
    continue
  }
  if (check.run) {
    console.log(`[computer-native] ${check.name}`)
    if (!check.run()) {
      failed = true
    }
    continue
  }
  if (!hasCommand(check.command)) {
    console.log(`[computer-native] skip ${check.name}: ${check.command} not found`)
    continue
  }
  console.log(`[computer-native] ${check.name}`)
  const result = spawnSync(check.command, check.args, {
    cwd: repoRoot,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: 'inherit'
  })
  if (result.status !== 0 || result.error) {
    failed = true
  }
}

if (failed) {
  process.exit(1)
}

function hasCommand(command) {
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', [command], { stdio: 'ignore' })
    return result.status === 0
  }
  if (existsSync(command)) {
    return true
  }
  const result = spawnSync('/bin/sh', ['-lc', `command -v ${quoteShell(command)}`], {
    stdio: 'ignore'
  })
  return result.status === 0
}

function verifyMacOSHelperApp() {
  const appPath = join(
    repoRoot,
    'native',
    'computer-use-macos',
    '.build',
    'release',
    'Quirky Computer Use.app'
  )
  if (!existsSync(appPath)) {
    console.error(
      `[computer-native] missing helper app at ${appPath}; run pnpm build:computer-macos`
    )
    return false
  }
  return run('codesign', ['--verify', '--deep', '--strict', appPath])
}

function verifyNativeArgumentGuardrails() {
  const macos = readFileSync(
    join(repoRoot, 'native/computer-use-macos/Sources/QuirkyComputerUseMacOS/main.swift'),
    'utf8'
  )
  const failures = []
  if (
    !macos.includes('private func typeText') ||
    !macos.includes('TextInput.replaceSelection(focused.element, with: text)')
  ) {
    failures.push(
      'macOS typeText must try verified focused AX text replacement before synthetic keyboard fallback'
    )
  }
  if (!macos.includes('even when the click uses an AX action path')) {
    failures.push(
      'macOS clicks must activate the target window before accessibility or pointer input'
    )
  }
  if (!macos.includes('"pid:\\(app.pid)"')) {
    failures.push(
      'macOS snapshot cache must alias follow-up actions by the documented pid:N selector'
    )
  }
  const macOSElementSignature = swiftFunctionBody(macos, 'elementSignature')
  if (
    macOSElementSignature?.includes('node.value') ||
    macOSElementSignature?.includes('node.placeholder')
  ) {
    failures.push(
      'macOS element identity must not include mutable text value or placeholder content'
    )
  }
  const macOSCurrentSnapshot = swiftFunctionBody(macos, 'currentSnapshot')
  const macOSPruneIndex = macOSCurrentSnapshot?.indexOf('pruneSnapshotCache()') ?? -1
  const macOSCachedIndex = macOSCurrentSnapshot?.indexOf('cachedSnapshot(params: params)') ?? -1
  if (macOSPruneIndex < 0 || macOSCachedIndex < 0 || macOSPruneIndex > macOSCachedIndex) {
    failures.push('macOS cached snapshots must be pruned before cached element lookup')
  }
  if (
    !macos.includes('"pageup": 116') ||
    !macos.includes('"pagedown": 121') ||
    !macos.includes('"insert": 114')
  ) {
    failures.push('macOS key aliases must accept common PageUp/PageDown/Insert names')
  }
  if (
    !macos.includes('haystack.contains("verification code")') ||
    !macos.includes('return "[redacted]"')
  ) {
    failures.push('macOS secure fields must redact verification-code/password-style values')
  }

  for (const failure of failures) {
    console.error(`[computer-native] ${failure}`)
  }
  return failures.length === 0
}

function swiftFunctionBody(source, name) {
  const start = source.indexOf(`func ${name}`)
  if (start === -1) {
    return null
  }
  const bodyStart = source.indexOf('{', start)
  if (bodyStart === -1) {
    return null
  }
  let depth = 0
  for (let index = bodyStart; index < source.length; index++) {
    const character = source[index]
    if (character === '{') {
      depth++
    } else if (character === '}') {
      depth--
      if (depth === 0) {
        return source.slice(start, index + 1)
      }
    }
  }
  return null
}

function run(command, args) {
  if (!hasCommand(command)) {
    console.log(`[computer-native] skip ${command}: command not found`)
    return true
  }
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  return result.status === 0 && !result.error
}

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
