function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = row
  }
  return previous[b.length]
}

const MAX_DISTANCE = 2
const MAX_SUGGESTIONS = 3

const byName = (a: { candidate: string; distance: number }, b: { candidate: string; distance: number }) =>
  a.distance - b.distance || (a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0)

/**
 * Up to three of `candidates` the user may have meant by `typed`: those within edit distance 2 or
 * starting with it, closest first, then by name. When none is close but `typed` starts in a known
 * group, the group's commands are offered instead (`acme.notes add` retired, `acme.notes list` kept).
 */
export function suggestCommands(typed: string, candidates: string[]): string[] {
  const others = candidates
    .filter((candidate) => candidate !== typed)
    .map((candidate) => ({ candidate, distance: distance(typed, candidate) }))
  const close = others.filter(({ candidate, distance }) => distance <= MAX_DISTANCE || candidate.startsWith(typed))
  const firstWord = typed.split(' ')[0]
  const pool = close.length ? close : others.filter(({ candidate }) => candidate.split(' ')[0] === firstWord)
  return pool
    .sort(byName)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ candidate }) => candidate)
}
