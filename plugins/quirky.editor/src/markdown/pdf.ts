import { spawn } from 'node:child_process'
import { accessSync, constants, copyFileSync, existsSync, linkSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, closeSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import { createEditorPrintHtml } from '@quirky/ui/editor-print'
const PDF_TIMEOUT_MS = 60_000
const MAX_PROCESS_OUTPUT = 8192

export type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

type ManagedProcessResult = { result: ProcessResult; outputComplete: boolean; shutdownRequested: boolean }

async function runProcessWithCompletion(
  command: string,
  args: string[],
  options: { timeoutMs: number; home?: string },
  isComplete?: () => boolean
): Promise<ManagedProcessResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ManagedProcessResult>()
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(options.home === undefined ? {} : { env: { ...process.env, HOME: options.home, USERPROFILE: options.home } })
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let outputComplete = false
  let shutdownRequested = false
  let processError: Error | null = null
  child.stdout?.on('data', (chunk: Buffer | string) => { stdout = (stdout + chunk.toString()).slice(-MAX_PROCESS_OUTPUT) })
  child.stderr?.on('data', (chunk: Buffer | string) => { stderr = (stderr + chunk.toString()).slice(-MAX_PROCESS_OUTPUT) })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, options.timeoutMs)
  const pollForCompletion = () => {
    if (!isComplete || outputComplete || child.exitCode !== null || child.signalCode !== null || !isComplete()) return
    outputComplete = true
    shutdownRequested = child.kill('SIGTERM')
  }
  const completionPoller = isComplete === undefined ? undefined : setInterval(pollForCompletion, 50)
  const cleanup = () => {
    clearTimeout(timer)
    clearInterval(completionPoller)
  }
  child.once('error', (error) => { processError = error })
  child.once('close', (code, signal) => {
    cleanup()
    if (processError) {
      reject(processError)
      return
    }
    if (timedOut) {
      reject(new Error(`Process timed out after ${options.timeoutMs} ms.`))
      return
    }
    resolve({ result: { code, signal, stdout, stderr }, outputComplete, shutdownRequested })
  })
  pollForCompletion()
  return promise
}

export async function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs: number; home?: string }
): Promise<ProcessResult> {
  return (await runProcessWithCompletion(command, args, options)).result
}

function isCompletePdfArtifact(path: string): boolean {
  try {
    assertPdfArtifact(path)
    return true
  } catch {
    return false
  }
}

function pdfProcessFailure(result: ProcessResult): Error {
  const detail = result.stderr || result.stdout || `exit code ${result.code}${result.signal ? `, signal ${result.signal}` : ''}`
  return new Error(`Chrome PDF export failed: ${detail}`)
}



function fileUrl(path: string): string {
  const encoded = path.split('/').map((part, index) => index === 0 ? '' : encodeURIComponent(part)).join('/')
  return `file://${encoded}`
}

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    join(homedir(), 'Applications/Chromium.app/Contents/MacOS/Chromium'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  throw new Error('PDF export requires an installed Google Chrome or Chromium browser. Set CHROME_PATH to its executable.')
}

let cachedPdfKatexCss: string | null = null

function pdfKatexCss(): string {
  if (cachedPdfKatexCss !== null) return cachedPdfKatexCss
  const require = createRequire(import.meta.url)
  const stylesheet = require.resolve('katex/dist/katex.min.css')
  const baseDirectory = dirname(stylesheet)
  let totalFontBytes = 0
  cachedPdfKatexCss = readFileSync(stylesheet, 'utf8').replace(/url\((['"]?)([^)'"]+)\1\)/g, (_match, quote: string, url: string) => {
    if (url.startsWith('data:')) return `url(${quote}${url}${quote})`
    if (!url.startsWith('fonts/') || url.includes('..')) throw new Error('KaTeX PDF styles reference an unsupported asset.')
    const fontPath = join(baseDirectory, url)
    const stat = statSync(fontPath)
    totalFontBytes += stat.size
    if (!stat.isFile() || totalFontBytes > 32 * 1024 * 1024) throw new Error('KaTeX PDF font assets exceed the inline asset limit.')
    const extension = url.slice(url.lastIndexOf('.')).toLowerCase()
    const mime = extension === '.woff2' ? 'font/woff2' : extension === '.woff' ? 'font/woff' : extension === '.ttf' ? 'font/ttf' : extension === '.otf' ? 'font/otf' : null
    if (!mime) throw new Error('KaTeX PDF references an unsupported font format.')
    return `url(data:${mime};base64,${readFileSync(fontPath).toString('base64')})`
  })
  return cachedPdfKatexCss
}

function makePdfHtml(title: string, body: string): string {
  return createEditorPrintHtml({ title, body, katexCss: pdfKatexCss(), theme: 'light' })
}

function assertPdfArtifact(path: string): void {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size < 128) throw new Error('Chrome did not produce a usable PDF artifact.')
  const descriptor = openSync(path, 'r')
  try {
    const signature = Buffer.alloc(5)
    if (readSync(descriptor, signature, 0, signature.length, 0) !== signature.length || signature.toString('ascii') !== '%PDF-') {
      throw new Error('Chrome output is not a valid PDF file.')
    }
    const tailLength = Math.min(stat.size, 2048)
    const tail = Buffer.alloc(tailLength)
    readSync(descriptor, tail, 0, tailLength, stat.size - tailLength)
    if (!/%%EOF\s*$/.test(tail.toString('latin1'))) throw new Error('Chrome output is an incomplete PDF file.')
  } finally {
    closeSync(descriptor)
  }
}

export async function exportPdfWithChrome(input: {
  title: string
  html: string
  outputPath: string
  replaceExisting: boolean
}): Promise<{ path: string; size: number }> {
  const chrome = findChrome()
  const temp = mkdtempSync(join(tmpdir(), 'quirky-markdown-pdf-'))
  const profile = join(temp, 'profile')
  const documentPath = join(temp, 'document.html')
  const renderedPdf = join(temp, 'rendered.pdf')
  let stagedPdf: string | null = null
  try {
    writeFileSync(documentPath, makePdfHtml(input.title, input.html), { encoding: 'utf8', mode: 0o600 })
    const { result, outputComplete, shutdownRequested } = await runProcessWithCompletion(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      `--user-data-dir=${profile}`,
      `--print-to-pdf=${renderedPdf}`,
      '--print-to-pdf-no-header',
      fileUrl(documentPath)
    ], { timeoutMs: PDF_TIMEOUT_MS, home: temp }, () => isCompletePdfArtifact(renderedPdf))
    // A handled SIGTERM can become a watchdog exit; the validated artifact predates our owned shutdown.
    if (result.code !== 0 && !(outputComplete && shutdownRequested)) throw pdfProcessFailure(result)
    assertPdfArtifact(renderedPdf)
    if (existsSync(input.outputPath) && !input.replaceExisting) throw new Error('PDF destination already exists.')
    stagedPdf = join(dirname(input.outputPath), `.${basename(input.outputPath)}.${randomUUID()}.tmp`)
    copyFileSync(renderedPdf, stagedPdf, constants.COPYFILE_EXCL)
    if (input.replaceExisting) renameSync(stagedPdf, input.outputPath)
    else {
      linkSync(stagedPdf, input.outputPath)
      unlinkSync(stagedPdf)
    }
    stagedPdf = null
    assertPdfArtifact(input.outputPath)
    return { path: input.outputPath, size: statSync(input.outputPath).size }
  } finally {
    if (stagedPdf && existsSync(stagedPdf)) unlinkSync(stagedPdf)
    rmSync(temp, { recursive: true, force: true })
  }
}

export async function choosePdfDestination(title: string): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('A native PDF save dialog is available only on macOS; pass an explicit authorized path.')
  const defaultName = `${basename(title).replace(/\.(?:md|markdown)$/i, '') || 'Document'}.pdf`
  const script = `POSIX path of (choose file name with prompt "Export Markdown as PDF" default name "${defaultName.replace(/[\\"]/g, '\\$&')}" )`
  const result = await runProcess('osascript', ['-e', script], { timeoutMs: 300_000 })
  if (result.code !== 0) {
    if (/-128|User canceled|User cancelled/i.test(`${result.stderr}\n${result.stdout}`)) return null
    throw new Error(`Could not open the PDF save dialog: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

