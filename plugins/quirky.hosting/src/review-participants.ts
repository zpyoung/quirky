import { isRecord } from './pr-data'

export type ReviewParticipants = {
  requestedReviewers: string[] | null
  reviews: { author: string | null; state: string }[] | null
  assignees: string[] | null
  participantsTruncated: boolean
}

function rows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  return isRecord(value) && Array.isArray(value.nodes) ? value.nodes : null
}

function logins(value: unknown[] | null): string[] | null {
  if (value === null) return null
  const result: string[] = []
  const seen = new Set<string>()
  for (const entry of value.slice(0, 100)) {
    const login = typeof entry === 'string' ? entry : isRecord(entry) ? entry.login ?? entry.slug ?? entry.name : null
    if (typeof login !== 'string' || login.length === 0 || login.length > 256) return null
    if (!seen.has(login)) { seen.add(login); result.push(login) }
  }
  return result
}

/** Missing provider fields stay unknown; only a real empty provider collection becomes []. */
export function reviewParticipants(raw: Record<string, unknown>): ReviewParticipants {
  const requested = rows(raw.reviewRequests)
  const assigned = rows(raw.assignees)
  const votes = rows(raw.reviews)
  let reviews: ReviewParticipants['reviews'] = votes === null ? null : []
  if (votes !== null) {
    for (const vote of votes.slice(-100)) {
      if (!isRecord(vote) || typeof vote.state !== 'string' || vote.state.length > 256) { reviews = null; break }
      const author = typeof vote.author === 'string' ? vote.author : isRecord(vote.author) && typeof vote.author.login === 'string' ? vote.author.login : null
      reviews!.push({ author, state: vote.state })
    }
  }
  return {
    requestedReviewers: logins(requested),
    reviews,
    assignees: logins(assigned),
    participantsTruncated: [requested, assigned, votes].some(value => value !== null && value.length > 100)
  }
}

export function isReviewParticipants(value: unknown): value is ReviewParticipants & Record<string, unknown> {
  if (!isRecord(value) || typeof value.participantsTruncated !== 'boolean') return false
  for (const key of ['requestedReviewers', 'assignees']) {
    const entries = value[key]
    if (entries !== null && (!Array.isArray(entries) || entries.length > 100 || entries.some(entry => typeof entry !== 'string' || entry.length === 0 || entry.length > 256))) return false
  }
  return value.reviews === null || (Array.isArray(value.reviews) && value.reviews.length <= 100 && value.reviews.every(vote => isRecord(vote) && (vote.author === null || typeof vote.author === 'string') && typeof vote.state === 'string'))
}
