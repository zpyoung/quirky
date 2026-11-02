const NAVIGATION_REASONS: Array<[RegExp, string]> = [
  [/ERR_UNSAFE_PORT/, 'Chrome blocks this port for safety, so the page was not loaded.'],
  [/ERR_CONNECTION_REFUSED/, 'Nothing is accepting connections at this address.'],
  [/ERR_NAME_NOT_RESOLVED/, 'The address could not be found.'],
  [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/, 'The site took too long to respond.'],
  [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/, 'There is no network connection.'],
  [/ERR_CERT_|ERR_SSL_/, 'The site\'s security certificate could not be verified.']
]

/** Plain-words reason for a Chrome load error, with the raw code kept as detail. Null when the text is not a Chrome load error. */
export function describeNavigationError(raw: string): { summary: string; detail: string } | null {
  const code = /net::ERR_[A-Z0-9_]+/.exec(raw)?.[0]
  if (!code) return null
  const reason = NAVIGATION_REASONS.find(([pattern]) => pattern.test(code))?.[1] ?? 'The page could not be loaded.'
  return { summary: reason, detail: code }
}
