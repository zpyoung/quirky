import type { StartedChild } from './child'

/** An unfinished process, attributed to the runner that started it. */
export type LiveProcess = { pid: number; owner: string; command: string; startedAt: number }

type Entry = {
  runner: symbol
  info: LiveProcess
  stop: () => void
  finished: Promise<void>
}
const entries = new Set<Entry>()
const retainedEntries = new Set<Entry>()

/** Tracks a leader until exit and retains its operation until it settles. */
export function registerProcess(
  runner: symbol,
  owner: string,
  command: string,
  child: StartedChild,
  stop: () => void,
  finished: Promise<void>,
): () => void {
  const entry: Entry = { runner, info: { pid: child.pid, owner, command, startedAt: Date.now() }, stop, finished }
  entries.add(entry)
  retainedEntries.add(entry)
  void finished.then(
    () => retainedEntries.delete(entry),
    () => retainedEntries.delete(entry),
  )
  return () => { entries.delete(entry) }
}

/** Returns snapshots of the unfinished children owned by one runner. */
export function processesForRunner(runner: symbol): LiveProcess[] {
  return [...entries].filter(entry => entry.runner === runner).map(entry => ({ ...entry.info }))
}

/** Returns snapshots of every unfinished child across owners. */
export function liveProcesses(): LiveProcess[] {
  return [...entries].map(entry => ({ ...entry.info }))
}

/** Immediately kills unfinished groups and waits for the affected operations to settle. */
export async function stopProcesses(runner?: symbol): Promise<void> {
  const selected = [...new Set([...entries, ...retainedEntries])]
    .filter(entry => runner === undefined || entry.runner === runner)
  for (const entry of selected) entry.stop()
  await Promise.all(selected.map(entry => entry.finished))
}

/** Kills every unfinished child and waits for them; runners stay usable. */
export function stopAllProcesses(): Promise<void> {
  return stopProcesses()
}
