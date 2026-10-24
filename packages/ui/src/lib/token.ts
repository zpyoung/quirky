/** Extracts `token` from a `location.hash` such as `#token=abc`; null when absent or empty. */
export function parseHashToken(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const token = params.get('token')
  return token ? token : null
}

export function rpcUrl(host: string, token: string): string {
  return `ws://${host}/rpc?token=${encodeURIComponent(token)}`
}
