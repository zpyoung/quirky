export const SHARD_TARGET_MS = 180000
export const MAX_SHARDS_PR = 6
export const MAX_SHARDS_MAIN = 12
/** How many recent main baselines a plan takes file durations from. */
export const DURATION_BASELINES = 5

const UNKNOWN_DURATION_MS = 5000

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Each file's median duration across several runs, so one slow or fast run doesn't decide where a
 * file goes. A file counts only in the runs that recorded it.
 */
export function medianDurations(runs: Record<string, number>[]): Record<string, number> {
  const seen = new Map<string, number[]>()
  for (const run of runs) {
    for (const [file, ms] of Object.entries(run)) {
      const list = seen.get(file)
      if (list) list.push(ms)
      else seen.set(file, [ms])
    }
  }
  return Object.fromEntries([...seen].map(([file, list]) => [file, median(list)]))
}

function weigh(files: string[], durations: Record<string, number>): { file: string; ms: number }[] {
  const known = Object.values(durations)
  const fallback = known.length > 0 ? median(known) : UNKNOWN_DURATION_MS
  return files
    .map((file) => ({ file, ms: file in durations ? durations[file]! : fallback }))
    .sort((a, b) => b.ms - a.ms || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

/**
 * `files` longest first by `durations`, with the same fallback and tie-breaking as `splitShards`, so a
 * job that runs several files at once starts its longest file first rather than last.
 */
export function longestFirst(files: string[], durations: Record<string, number>): string[] {
  return weigh(files, durations).map(({ file }) => file)
}

/**
 * Splits `files` into balanced shards by recorded duration, longest first onto the least-loaded
 * shard. A file with no entry in `durations` counts as the median of every duration in `durations`,
 * selected or not, or 5,000 ms when it is empty. The shard count is `min(maxShards, ceil(total / targetMs))`, at least 1, and never
 * more than the number of files so no shard is empty. Returns `[]` for no files. The result depends
 * only on the inputs' contents, not their order: ties go to the lower path, then the lower shard.
 * Each shard lists its files longest first.
 */
export function splitShards(
  files: string[],
  durations: Record<string, number>,
  opts: { targetMs: number; maxShards: number }
): string[][] {
  if (files.length === 0) return []
  const weighted = weigh(files, durations)
  const total = weighted.reduce((sum, { ms }) => sum + ms, 0)
  const count = Math.max(1, Math.min(opts.maxShards, Math.ceil(total / opts.targetMs), files.length))
  const shards: string[][] = Array.from({ length: count }, () => [])
  const loads = new Array<number>(count).fill(0)
  for (const { file, ms } of weighted) {
    let target = 0
    for (let i = 1; i < count; i++) if (loads[i]! < loads[target]!) target = i
    shards[target]!.push(file)
    loads[target]! += ms
  }
  return shards
}
