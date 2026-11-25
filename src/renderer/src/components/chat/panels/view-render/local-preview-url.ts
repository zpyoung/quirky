const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

/** The normalized URL when it is an http(s) address on localhost or 127.0.0.1 without credentials, else null. */
export function localPreviewUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const web = url.protocol === 'http:' || url.protocol === 'https:'
  if (!web || !LOCAL_HOSTS.has(url.hostname) || url.username !== '' || url.password !== '') {
    return null
  }
  return url.href
}
