import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { HookInput } from './service'

const SPOOL_FILE = /^(.+)\.jsonl$/
const CLAIMED_FILE = /^(.+)\.jsonl\.draining$/
const MAX_ROUNDS = 8
const MAX_AGE_MS = 7 * 24 * 3_600_000
const MAX_FILES = 1024

const unset = (field: string) => (field === '-' ? '' : field)

function fromBase64(text: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
  try {
    return Buffer.from(text, 'base64').toString('utf8')
  } catch {
    return null
  }
}

/**
 * One spool line as a hook: `<source> <pid> <pstart-base64> <event> <payload-base64>`, `-` for an
 * empty field. Null for a line that doesn't have that shape or whose payload isn't JSON.
 */
export function parseSpoolLine(line: string, sessionId: string, at: number): HookInput | null {
  const fields = line.trim().split(' ')
  if (fields.length !== 5) return null
  const [source, pid, pstart, event, payload] = fields as [string, string, string, string, string]
  if (source === '-' || (pid !== '-' && !/^\d{1,10}$/.test(pid))) return null
  const agentStart = fromBase64(unset(pstart))
  const body = fromBase64(unset(payload))
  if (agentStart === null || !body) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  return {
    source,
    sessionId,
    payload: parsed,
    ...(unset(event) !== '' ? { event: unset(event) } : {}),
    ...(pid !== '-' ? { agentPid: Number(pid) } : {}),
    ...(agentStart !== '' ? { agentStart } : {}),
    at,
    replay: true
  }
}

/**
 * Replays what the shim spooled while the daemon was down, each session's lines in order, then
 * deletes them. Files past seven days are deleted unread; sessions beyond the 1024th stay for
 * the next start. Replayed hooks never notify. A line the shim appends mid-replay is replayed
 * too; one still arriving after the bounded re-checks waits for the next start.
 */
export async function drainSpool(home: string, ingest: (input: HookInput) => Promise<void>, now: number = Date.now()): Promise<void> {
  const dir = join(home, 'hook-spool')
  let sessions: string[]
  try {
    sessions = [...new Set(readdirSync(dir).flatMap((name) => SPOOL_FILE.exec(name)?.[1] ?? CLAIMED_FILE.exec(name)?.[1] ?? []))]
      .sort()
      .slice(0, MAX_FILES)
  } catch {
    return
  }
  for (const sessionId of sessions) {
    const live = join(dir, `${sessionId}.jsonl`)
    const claimed = `${live}.draining`
    try {
      // a claim left by an interrupted drain holds older lines than the live file
      if (existsSync(claimed)) await replayFile(claimed, sessionId, ingest, now)
      for (let round = 0; round < MAX_ROUNDS && existsSync(live); round++) {
        // after the rename a shim's next append creates a fresh file instead of landing in one about to be deleted
        renameSync(live, claimed)
        await replayFile(claimed, sessionId, ingest, now)
      }
    } catch {
      // an unreadable file stays for the next start
    }
  }
}

async function replayFile(file: string, sessionId: string, ingest: (input: HookInput) => Promise<void>, now: number): Promise<void> {
  const modified = statSync(file).mtimeMs
  if (now - modified <= MAX_AGE_MS) {
    let consumed = 0
    for (;;) {
      // a shim that opened the file before the rename can still append to it
      const text = readFileSync(file, 'utf8')
      if (text.length === consumed) break
      for (const line of text.slice(consumed).split('\n')) {
        const input = line.trim() === '' ? null : parseSpoolLine(line, sessionId, Math.min(modified, now))
        if (input) await ingest(input)
      }
      consumed = text.length
    }
  }
  unlinkSync(file)
}
