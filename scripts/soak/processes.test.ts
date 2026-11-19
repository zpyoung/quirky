import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessRow } from './contracts'
import { ownedProcesses, parseProcessTable } from './processes'

test('parses macOS and Linux ps rows, preserving commands and empty commands', () => {
  const text = [
    '  4242     1 Ss   15432 Mon Nov  9 10:11:12 2026 /opt/homebrew/bin/bun scripts/soak.ts --out /tmp/soak run',
    '  9001  8988 Z        0 Tue Nov 10 11:12:13 2026 (git)',
    '  9002  9001 S        1 Tue Nov 10 11:12:14 2026 /usr/bin/node /home/runner/project with spaces/worker.ts',
    '  9003  9002 S        0 Tue Nov 10 11:12:15 2026 ',
    'not-a-pid 9002 S 12 Wed Nov 11 12:13:14 2026 /bin/sh'
  ].join('\n')

  expect(parseProcessTable(text)).toEqual([
    {
      pid: 4242,
      ppid: 1,
      state: 'Ss',
      rssKb: 15432,
      started: 'Mon Nov  9 10:11:12 2026',
      command: '/opt/homebrew/bin/bun scripts/soak.ts --out /tmp/soak run'
    },
    {
      pid: 9001,
      ppid: 8988,
      state: 'Z',
      rssKb: 0,
      started: 'Tue Nov 10 11:12:13 2026',
      command: '(git)'
    },
    {
      pid: 9002,
      ppid: 9001,
      state: 'S',
      rssKb: 1,
      started: 'Tue Nov 10 11:12:14 2026',
      command: '/usr/bin/node /home/runner/project with spaces/worker.ts'
    },
    {
      pid: 9003,
      ppid: 9002,
      state: 'S',
      rssKb: 0,
      started: 'Tue Nov 10 11:12:15 2026',
      command: ''
    }
  ])
})

test('reads C-formatted ps rows when the caller uses a non-English locale', async () => {
  const result = await runProcessTableWithPs(`#!/bin/sh
if [ "$LC_ALL" = "C" ]; then
  printf '%s\\n' '4242 1 S 100 Mon Nov  9 10:11:12 2026 /standin/c-format'
else
  printf '%s\\n' '4242 1 S 100 lun. nov.  9 10:11:12 2026 /standin/fr-format'
fi
`, 'fr_FR.UTF-8')

  expect(result.exitCode, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([
    {
      pid: 4242,
      ppid: 1,
      state: 'S',
      rssKb: 100,
      started: 'Mon Nov  9 10:11:12 2026',
      command: '/standin/c-format'
    }
  ])
})

test('returns null when ps succeeds but produces no parseable process rows', async () => {
  const result = await runProcessTableWithPs(`#!/bin/sh
printf '%s\\n' 'ps succeeded but emitted no process rows'
`, 'C')

  expect(result.exitCode, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toBeNull()
})


test('finds descendants and grandchildren independent of row order, excluding roots and unrelated processes', () => {
  const rows = [
    processRow(303, 202, 'Wed Nov 11 12:13:15 2026'),
    processRow(900, 1, 'Wed Nov 11 12:13:16 2026'),
    processRow(101, 1, 'Wed Nov 11 12:13:10 2026'),
    processRow(202, 101, 'Wed Nov 11 12:13:14 2026'),
    processRow(200, 1, 'Wed Nov 11 12:13:11 2026'),
    processRow(201, 200, 'Wed Nov 11 12:13:12 2026'),
    processRow(102, 101, 'Wed Nov 11 12:13:13 2026')
  ]

  const owned = ownedProcesses(rows, [101, 200], new Set())

  expect(owned.map(({ pid }) => pid).sort((a, b) => a - b)).toEqual([102, 201, 202, 303])
})

test('keeps previously owned orphans by pid and start time, but not a reused pid', () => {
  const seen = new Set<string>()
  const initialRows = [
    processRow(311, 101, 'Wed Nov 11 12:13:11 2026'),
    processRow(310, 101, 'Wed Nov 11 12:13:10 2026')
  ]

  const initiallyOwned = ownedProcesses(initialRows, [101], seen)
  expect(initiallyOwned.map(({ pid }) => pid).sort((a, b) => a - b)).toEqual([310, 311])
  expect(seen).toEqual(new Set([
    '310:Wed Nov 11 12:13:10 2026',
    '311:Wed Nov 11 12:13:11 2026'
  ]))

  const laterRows = [
    processRow(311, 1, 'Wed Nov 11 12:14:11 2026'),
    processRow(310, 1, 'Wed Nov 11 12:13:10 2026'),
    processRow(700, 1, 'Wed Nov 11 12:14:12 2026')
  ]

  const stillOwned = ownedProcesses(laterRows, [101], seen)

  expect(stillOwned.map(({ pid }) => pid)).toEqual([310])
  expect(seen).toEqual(new Set([
    '310:Wed Nov 11 12:13:10 2026',
    '311:Wed Nov 11 12:13:11 2026'
  ]))
})

function processRow(pid: number, ppid: number, started: string): ProcessRow {
  return { pid, ppid, state: 'S', rssKb: 100, started, command: `process ${pid}` }
}
async function runProcessTableWithPs(psScript: string, callerLocale: string) {
  const root = mkdtempSync(join(tmpdir(), 'soak-process-table-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const psPath = join(bin, 'ps')
    writeFileSync(psPath, psScript)
    chmodSync(psPath, 0o700)

    const moduleUrl = new URL('./processes.ts', import.meta.url).href
    const source = `import { readProcessTable } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(await readProcessTable()))`
    const child = Bun.spawn([process.execPath, '-e', source], {
      env: { ...process.env, LC_ALL: callerLocale, PATH: bin },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    return { stdout, stderr, exitCode }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
