import { runProcess } from './pdf'

function cancelled(result: { stderr: string; stdout: string }): boolean {
  return /-128|User canceled|User cancelled/i.test(`${result.stderr}\n${result.stdout}`)
}

export async function chooseMarkdownImage(): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('A native image chooser is available only on macOS; pass an authorized worktree-relative image path.')
  const result = await runProcess('osascript', ['-e', 'POSIX path of (choose file with prompt "Import an image into this Markdown document")'], { timeoutMs: 300_000 })
  if (result.code !== 0) {
    if (cancelled(result)) return null
    throw new Error(`Could not open the image chooser: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

export async function confirmNativeReplacement(path: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  const quoted = path.replace(/[\\"]/g, '\\$&').replace(/[\r\n]/g, ' ')
  const script = `display dialog "${quoted} already exists. Replace it?" buttons {"Cancel", "Replace"} default button "Replace" cancel button "Cancel"`
  const result = await runProcess('osascript', ['-e', script], { timeoutMs: 300_000 })
  if (result.code !== 0) {
    if (cancelled(result)) return false
    throw new Error(`Could not confirm replacement: ${result.stderr || result.stdout}`)
  }
  return /button returned:Replace/i.test(result.stdout)
}
