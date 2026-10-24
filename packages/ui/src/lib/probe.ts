type Fetcher = (url: string) => Promise<Response>

const PROBE_TIMEOUT_MS = 1500

/** True when the daemon that serves this page answers `GET /health` on the same origin. */
export async function daemonAnswers(
  host: string,
  fetcher: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' })
): Promise<boolean> {
  try {
    return (await fetcher(`http://${host}/health`)).ok
  } catch {
    return false
  }
}
