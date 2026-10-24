/** The URL the window loads; the UI reads the RPC token from the hash. */
export function daemonUrl(info: { port: number; token: string }): string {
  return `http://127.0.0.1:${info.port}/#token=${encodeURIComponent(info.token)}`
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Self-contained page shown instead of the UI when the daemon cannot be started. */
export function errorPageHtml(message: string, logPath: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Quirky</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 48px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  pre { white-space: pre-wrap; background: rgba(127,127,127,.15); padding: 12px; border-radius: 6px; }
  code { font-family: ui-monospace, Menlo, monospace; }
</style></head>
<body>
  <h1>Quirky could not start its daemon</h1>
  <pre>${escapeHtml(message)}</pre>
  <p>Daemon log: <code>${escapeHtml(logPath)}</code></p>
  <p>The shell keeps retrying; this page stays until the daemon is reachable.</p>
</body></html>`
}
