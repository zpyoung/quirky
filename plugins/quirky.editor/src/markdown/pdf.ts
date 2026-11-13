import type { ProcessSpawner, SpawnExit, SpawnOptions, SpawnedProcess, StopOptions } from '@quirky/protocol'
import { accessSync, constants, copyFileSync, existsSync, linkSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, closeSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import { createEditorPrintHtml } from '@quirky/ui/editor-print'
const PDF_TIMEOUT_MS = 60_000
const MAX_PROCESS_OUTPUT = 8192

export type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

type ProcessOptions = { timeoutMs: number; home?: string; signal?: AbortSignal }
type ManagedProcessResult = {
  result: ProcessResult
  exit: SpawnExit
  outputComplete: boolean
  shutdownRequested: boolean
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function runProcessWithCompletion(
  runner: ProcessSpawner,
  command: string,
  args: string[],
  options: ProcessOptions,
  isComplete?: () => boolean,
  pollIntervalMs = 50
): Promise<ManagedProcessResult> {
  if (options.signal?.aborted) throw new Error('Process was aborted.')
  const spawnOptions: SpawnOptions = {
    timeoutMs: options.timeoutMs,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'tail',
    stderrTailBytes: MAX_PROCESS_OUTPUT * 4,
    killGraceMs: 0,
    ...(options.home === undefined ? {} : { env: { ...process.env, HOME: options.home, USERPROFILE: options.home } }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  }
  let child: SpawnedProcess
  try {
    child = runner.spawn([command, ...args], spawnOptions)
  } catch (error) {
    throw asError(error)
  }

  let stdout = ''
  let outputComplete = false
  let shutdownRequested = false
  let timedOut = false
  let aborted = false
  let exitSettled = false
  let exitResult: SpawnExit | undefined
  let readFailed = false
  let readFailure: unknown
  let completionFailed = false
  let completionFailure: unknown
  let stopFailed = false
  let stopFailure: unknown
  let outputReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const stopOperations: Promise<void>[] = []

  function requestStop(stopOptions: StopOptions, cancelOutput = false): void {
    try {
      const operation = child.stop(stopOptions)
      stopOperations.push(Promise.resolve(operation).then(
        () => {},
        (error: unknown) => {
          if (!stopFailed) {
            stopFailed = true
            stopFailure = error
          }
        }
      ))
    } catch (error) {
      if (!stopFailed) {
        stopFailed = true
        stopFailure = error
      }
    }
    if (cancelOutput && outputReader) {
      try {
        void outputReader.cancel().catch(() => {})
      } catch {}
    }
  }

  const exitPromise = child.exited.then(
    (exit) => {
      exitSettled = true
      exitResult = exit
      return exit
    },
    (error: unknown) => {
      requestStop({ signal: 'SIGKILL', graceMs: 0 }, true)
      throw error
    }
  )
  const drainPromise = (async () => {
    const reader = child.stdout.getReader()
    outputReader = reader
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        const decoded = done ? decoder.decode() : decoder.decode(value, { stream: true })
        if (decoded !== '') {
          stdout += decoded
          if (stdout.length > MAX_PROCESS_OUTPUT) stdout = stdout.slice(-MAX_PROCESS_OUTPUT)
        }
        if (done) break
      }
    } catch (error) {
      readFailed = true
      readFailure = error
      throw error
    } finally {
      reader.releaseLock()
    }
  })()
  const timer = setTimeout(() => {
    timedOut = true
    requestStop({ signal: 'SIGKILL', graceMs: 0 }, true)
  }, options.timeoutMs)
  const pollForCompletion = () => {
    if (isComplete === undefined || outputComplete || exitSettled || timedOut || aborted || options.signal?.aborted) return
    let complete: boolean
    try {
      complete = isComplete()
    } catch (error) {
      completionFailed = true
      completionFailure = error
      requestStop({ signal: 'SIGKILL', graceMs: 0 }, true)
      return
    }
    if (!complete) return
    outputComplete = true
    shutdownRequested = true
    requestStop({ graceMs: 2000 })
  }
  const completionPoller = isComplete === undefined ? undefined : setInterval(pollForCompletion, pollIntervalMs)
  const abortProcess = () => {
    aborted = true
    requestStop({ signal: 'SIGKILL', graceMs: 0 }, true)
  }
  options.signal?.addEventListener('abort', abortProcess, { once: true })
  if (options.signal?.aborted) abortProcess()
  if (isComplete !== undefined) queueMicrotask(pollForCompletion)

  let joinFailed = false
  let joinFailure: unknown
  try {
    const [, exit] = await Promise.all([drainPromise, exitPromise])
    exitResult = exit
  } catch (error) {
    joinFailed = true
    joinFailure = error
    requestStop({ signal: 'SIGKILL', graceMs: 0 }, true)
    await Promise.allSettled([drainPromise, exitPromise])
  }
  let waitedForStops = 0
  while (waitedForStops < stopOperations.length) {
    await stopOperations[waitedForStops]!
    waitedForStops += 1
  }
  clearTimeout(timer)
  clearInterval(completionPoller!)
  options.signal?.removeEventListener('abort', abortProcess)

  if (readFailed) throw readFailure
  if (completionFailed) throw asError(completionFailure)
  if (joinFailed) throw asError(joinFailure)
  if (stopFailed) throw asError(stopFailure)
  const exit = exitResult!
  if (exit.spawnError) throw new Error(exit.spawnError.message)
  if (timedOut || exit.stopped === 'timeout') throw new Error(`Process timed out after ${options.timeoutMs} ms.`)
  if (aborted || options.signal?.aborted || exit.stopped === 'aborted') throw new Error('Process was aborted.')
  const ownedCompletionStop = isComplete !== undefined && outputComplete && shutdownRequested && exit.stopped === 'stop'
  if (exit.stopped === 'stop' && !ownedCompletionStop) throw new Error('Process was stopped.')
  return {
    result: {
      code: exit.exitCode,
      signal: exit.signal as NodeJS.Signals | null,
      stdout,
      stderr: child.stderrTail().slice(-MAX_PROCESS_OUTPUT)
    },
    exit,
    outputComplete,
    shutdownRequested
  }
}

export async function runProcess(
  runner: ProcessSpawner,
  command: string,
  args: string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  return (await runProcessWithCompletion(runner, command, args, options)).result
}

function isCompletePdfArtifact(path: string): boolean {
  try {
    assertPdfArtifact(path)
    return true
  } catch {
    return false
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Process was aborted.')
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

export async function exportPdfWithChrome(
  runner: ProcessSpawner,
  input: {
    title: string
    html: string
    outputPath: string
    replaceExisting: boolean
  },
  options: { signal?: AbortSignal; timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<{ path: string; size: number }> {
  assertNotAborted(options.signal)
  const chrome = findChrome()
  const temp = mkdtempSync(join(tmpdir(), 'quirky-markdown-pdf-'))
  const profile = join(temp, 'profile')
  const documentPath = join(temp, 'document.html')
  const renderedPdf = join(temp, 'rendered.pdf')
  const timeoutMs = options.timeoutMs ?? PDF_TIMEOUT_MS
  let stagedPdf: string | null = null
  try {
    writeFileSync(documentPath, makePdfHtml(input.title, input.html), { encoding: 'utf8', mode: 0o600 })
    assertNotAborted(options.signal)
    const completion = await runProcessWithCompletion(runner, chrome, [
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
    ], { timeoutMs, home: temp, signal: options.signal }, () => isCompletePdfArtifact(renderedPdf), options.pollIntervalMs ?? 50)
    const { result, exit, outputComplete, shutdownRequested } = completion
    // Publish only after a clean exit or the stop owned by an observed complete artifact.
    const cleanExit = exit.exitCode === 0 && exit.signal === null && exit.stopped === undefined
    const ownedCompletion = outputComplete && shutdownRequested && exit.stopped === 'stop'
    if (!cleanExit && !ownedCompletion) throw pdfProcessFailure(result)
    assertPdfArtifact(renderedPdf)
    assertNotAborted(options.signal)
    if (existsSync(input.outputPath) && !input.replaceExisting) throw new Error('PDF destination already exists.')
    stagedPdf = join(dirname(input.outputPath), `.${basename(input.outputPath)}.${randomUUID()}.tmp`)
    copyFileSync(renderedPdf, stagedPdf, constants.COPYFILE_EXCL)
    assertNotAborted(options.signal)
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

export async function choosePdfDestination(runner: ProcessSpawner, title: string, signal?: AbortSignal): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('A native PDF save dialog is available only on macOS; pass an explicit authorized path.')
  const defaultName = `${basename(title).replace(/\.(?:md|markdown)$/i, '') || 'Document'}.pdf`
  const script = `POSIX path of (choose file name with prompt "Export Markdown as PDF" default name "${defaultName.replace(/[\\"]/g, '\\$&')}" )`
  const result = await runProcess(runner, 'osascript', ['-e', script], { timeoutMs: 300_000, signal })
  if (result.code !== 0) {
    if (/-128|User canceled|User cancelled/i.test(`${result.stderr}\n${result.stdout}`)) return null
    throw new Error(`Could not open the PDF save dialog: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}
