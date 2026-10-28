function isTailscaleIPv4(host: string): boolean {
  const octets = host.split('.')
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return false
  const [first, second, third, fourth] = octets.map(Number)
  return first === 100 && second! >= 64 && second! <= 127 && third! <= 255 && fourth! <= 255
}

export function describeDirectPath(endpoint: string): string {
  try {
    const host = new URL(endpoint).hostname.toLowerCase()
    return isTailscaleIPv4(host) || host === 'ts.net' || host.endsWith('.ts.net')
      ? 'Direct · Tailscale'
      : 'Direct · LAN or configured address'
  } catch {
    return 'Direct endpoint'
  }
}
