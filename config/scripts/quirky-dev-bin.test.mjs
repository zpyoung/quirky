import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = path.resolve(import.meta.dirname, '../..')
const wrapperPath = path.join(projectDir, 'config', 'scripts', 'quirky-dev.mjs')

describe('quirky-dev package bin', () => {
  it('runs the dev CLI through Node without requiring Bash', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'quirky-dev-bin-'))
    const cliEntry = path.join(root, 'cli-entry.cjs')
    const outputPath = path.join(root, 'output.json')
    writeFileSync(
      cliEntry,
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({`,
        '  argv: process.argv.slice(2),',
        '  userDataPath: process.env.QUIRKY_USER_DATA_PATH,',
        '  devCliInvocation: process.env.QUIRKY_DEV_CLI_INVOCATION,',
        '  appExecutable: process.env.QUIRKY_APP_EXECUTABLE',
        '}));'
      ].join('\n'),
      'utf8'
    )
    if (process.platform !== 'win32') {
      chmodSync(cliEntry, 0o755)
    }

    execFileSync(process.execPath, [wrapperPath, '--help'], {
      env: {
        ...process.env,
        QUIRKY_DEV_CLI_ENTRY_PATH: cliEntry,
        QUIRKY_DEV_USER_DATA_PATH: path.join(root, 'user-data'),
        QUIRKY_APP_EXECUTABLE: path.join(root, 'Electron')
      },
      stdio: 'ignore'
    })

    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({
      argv: ['--help'],
      userDataPath: path.join(root, 'user-data'),
      devCliInvocation: '1',
      appExecutable: path.join(root, 'Electron')
    })
  })
})
