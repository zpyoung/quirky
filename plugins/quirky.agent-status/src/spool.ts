import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { HookInput } from './service'

const SPOOL_FILE = /^(.+)\.jsonl$/
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
 * Replays what the shim spooled while the daemon was down, each file's lines in order, then
 * deletes the file. Files past seven days are deleted unread; files beyond the 1024th stay
 * for the next start. Replayed hooks never notify.
 */
export async function drainSpool(home: string, ingest: (input: HookInput) => Promise<void>, now: number = Date.now()): Promise<void> {
  const dir = join(home, 'hook-spool')
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((name) => SPOOL_FILE.test(name))
      .sort()
      .slice(0, MAX_FILES)
  } catch {
    return
  }
  for (const name of names) {
    const file = join(dir, name)
    try {
      const modified = statSync(file).mtimeMs
      if (now - modified <= MAX_AGE_MS) {
        const sessionId = SPOOL_FILE.exec(name)![1]!
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          const input = line.trim() === '' ? null : parseSpoolLine(line, sessionId, Math.min(modified, now))
          if (input) await ingest(input)
        }
      }
      unlinkSync(file)
    } catch {
      // an unreadable file stays for the next start
    }
  }
}
