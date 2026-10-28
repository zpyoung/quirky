import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { BrowserFamily, ImportJob, ImportSource, ImportSummary } from '../cookies/types'
import type { DetectedBrowser } from '../cookies/sources'
import type { CookieImportPanelProps } from '../preferences/contract'

const POLL_INTERVAL_MS = 500
const BROWSER_FAMILIES: readonly BrowserFamily[] = ['chrome', 'edge', 'arc', 'chromium', 'comet', 'helium', 'firefox', 'safari']

type ImportActivity = {
  target: CookieImportPanelProps['destination']
  sourceLabel: string
  status: 'reading' | 'confirming' | 'queued' | 'running' | 'succeeded' | 'failed'
  result?: ImportSummary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBrowserFamily(value: unknown): value is BrowserFamily {
  return typeof value === 'string' && BROWSER_FAMILIES.includes(value as BrowserFamily)
}

function isDetectedBrowser(value: unknown): value is DetectedBrowser {
  if (!isRecord(value) || !isBrowserFamily(value.family) || typeof value.label !== 'string' || !Array.isArray(value.profiles)) return false
  return value.profiles.every((profile) => isRecord(profile) && typeof profile.name === 'string' && typeof profile.label === 'string')
}

function isDetectionResult(value: unknown): value is { browsers: DetectedBrowser[] } {
  return isRecord(value) && Array.isArray(value.browsers) && value.browsers.every(isDetectedBrowser)
}

function isImportSummary(value: unknown): value is ImportSummary {
  return isRecord(value) &&
    typeof value.totalCookies === 'number' &&
    typeof value.importedCookies === 'number' &&
    typeof value.skippedCookies === 'number' &&
    Array.isArray(value.domains) &&
    value.domains.every((domain) => typeof domain === 'string') &&
    (value.googleCookiesSkipped === undefined || typeof value.googleCookiesSkipped === 'number') &&
    (value.partitionSkippedCookies === undefined || typeof value.partitionSkippedCookies === 'number') &&
    (value.warning === undefined || (isRecord(value.warning) && typeof value.warning.code === 'string' &&
      (value.warning.reasons === undefined || (Array.isArray(value.warning.reasons) && value.warning.reasons.every((reason) => typeof reason === 'string')))))
}

function isImportJob(value: unknown): value is ImportJob {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.profileId !== 'string' ||
    (value.status !== 'queued' && value.status !== 'running' && value.status !== 'succeeded' && value.status !== 'failed')) return false
  if (value.status === 'succeeded') return isImportSummary(value.result)
  if (value.status === 'failed') return isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string'
  return true
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim() !== '') return cause.message
  if (typeof cause === 'string' && cause.trim() !== '') return cause
  return fallback
}

function browserSource(browser: DetectedBrowser, profileName: string): ImportSource {
  if (browser.family === 'safari') return { kind: 'browser', family: browser.family }
  return { kind: 'browser', family: browser.family, profile: profileName }
}

export function CookieImportPanel({ context, imports, destination, loadError, onHideHint, onError, onImported }: CookieImportPanelProps) {
  const [browsers, setBrowsers] = useState<DetectedBrowser[]>([])
  const [detecting, setDetecting] = useState(false)
  const [detectionError, setDetectionError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fileDialogOpen, setFileDialogOpen] = useState(false)
  const [activity, setActivity] = useState<ImportActivity | null>(null)
  const mountedRef = useRef(false)
  const detectionRequestRef = useRef(0)
  const detectingRef = useRef(false)
  const busyRef = useRef(false)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPollWaitRef = useRef<(() => void) | null>(null)
  const contextRef = useRef(context)
  const callbacksRef = useRef({ onError, onImported, onHideHint })
  contextRef.current = context
  callbacksRef.current = { onError, onImported, onHideHint }

  const reportError = (message: string) => {
    if (!mountedRef.current) return
    setError(message)
    contextRef.current.toast('Cookie import failed', message, { kind: 'error' })
    callbacksRef.current.onError(message)
  }

  const detectSources = useCallback(async () => {
    if (!mountedRef.current || detectingRef.current) return
    detectingRef.current = true
    const requestId = ++detectionRequestRef.current
    setDetecting(true)
    setDetectionError(null)
    try {
      const response = await contextRef.current.call('quirky.browser/detectBrowsers')
      if (!mountedRef.current || requestId !== detectionRequestRef.current) return
      if (!isDetectionResult(response)) throw new Error('Browser detection returned an invalid response.')
      setBrowsers(response.browsers)
    } catch (cause) {
      if (!mountedRef.current || requestId !== detectionRequestRef.current) return
      const message = errorMessage(cause, 'Could not detect supported browsers.')
      setDetectionError(message)
      contextRef.current.toast('Browser sources unavailable', message, { kind: 'error' })
      callbacksRef.current.onError(message)
    } finally {
      if (requestId === detectionRequestRef.current) {
        detectingRef.current = false
        if (mountedRef.current) setDetecting(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void detectSources()
    return () => {
      mountedRef.current = false
      detectionRequestRef.current += 1
      detectingRef.current = false
      const cancelPollWait = cancelPollWaitRef.current
      cancelPollWaitRef.current = null
      cancelPollWait?.()
    }
  }, [context, detectSources])

  const waitForNextPoll = () => {
    const { promise, resolve } = Promise.withResolvers<boolean>()
    let timer: ReturnType<typeof setTimeout>
    timer = setTimeout(() => {
      if (pollTimerRef.current === timer) pollTimerRef.current = null
      cancelPollWaitRef.current = null
      resolve(true)
    }, POLL_INTERVAL_MS)
    pollTimerRef.current = timer
    cancelPollWaitRef.current = () => {
      clearTimeout(timer)
      if (pollTimerRef.current === timer) pollTimerRef.current = null
      cancelPollWaitRef.current = null
      resolve(false)
    }
    return promise
  }

  const pollImport = async (jobId: string, target: CookieImportPanelProps['destination'], sourceLabel: string): Promise<void> => {
    while (mountedRef.current) {
      const response = await contextRef.current.call('quirky.browser/importGet', { id: jobId })
      if (!mountedRef.current) return
      if (!isImportJob(response) || response.id !== jobId || response.profileId !== target.id) {
        throw new Error('The import job returned an invalid status.')
      }
      if (response.status === 'queued' || response.status === 'running') {
        setActivity({ target, sourceLabel, status: response.status })
        if (!await waitForNextPoll() || !mountedRef.current) return
        continue
      }
      if (response.status === 'failed') throw new Error(response.error?.message || 'Cookie import failed.')
      if (!response.result) throw new Error('The import job completed without a summary.')

      setActivity({ target, sourceLabel, status: 'succeeded', result: response.result })
      const result = response.result
      const warning = result.warning
        ? ` Engine warning ${result.warning.code}${result.warning.reasons?.length ? `: ${result.warning.reasons.join('; ')}` : ''}.`
        : ''
      const body = `Imported from ${sourceLabel}. ${result.importedCookies} imported, ${result.skippedCookies} skipped of ${result.totalCookies} total for managed Chrome profile ${target.label}. Google cookies skipped: ${result.googleCookiesSkipped ?? 0}; partitioned cookies skipped: ${result.partitionSkippedCookies ?? 0}. Native browser sessions remain separate.${warning}`
      contextRef.current.toast(`Cookies imported to ${target.label}`, body, { kind: 'success' })
      try {
        await callbacksRef.current.onImported()
      } catch {
        // The import succeeded; a preference refresh failure does not change its result.
      }
      return
    }
  }

  const runImport = async (
    target: CookieImportPanelProps['destination'],
    sourceLabel: string,
    getSource: () => Promise<ImportSource>
  ) => {
    if (busyRef.current || imports?.available !== true) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    setActivity({ target, sourceLabel, status: sourceLabel === 'JSON file' ? 'reading' : 'confirming' })
    try {
      const source = await getSource()
      if (!mountedRef.current) return
      setActivity({ target, sourceLabel, status: 'confirming' })
      const confirmed = await contextRef.current.confirm({
        title: `Replace cookies in ${target.label}?`,
        body: `Import ${sourceLabel} into the managed Chrome profile ${target.label}. Matching site cookies may be replaced. Google cookies are skipped. Native browser sessions are separate.`,
        confirmLabel: 'Import Cookies'
      })
      if (!mountedRef.current) return
      if (!confirmed) {
        setActivity(null)
        return
      }
      const response = await contextRef.current.call('quirky.browser/importStart', {
        profile: target.id,
        source,
        yes: true
      })
      if (!mountedRef.current) return
      if (!isRecord(response) || typeof response.id !== 'string' || response.id.length === 0) {
        throw new Error('The cookie import did not return a job ID.')
      }
      const jobId = response.id
      setFileDialogOpen(false)
      setActivity({ target, sourceLabel, status: 'queued' })
      await pollImport(jobId, target, sourceLabel)
    } catch (cause) {
      if (!mountedRef.current) return
      const message = errorMessage(cause, 'Cookie import failed.')
      setActivity({ target, sourceLabel, status: 'failed' })
      reportError(message)
    } finally {
      if (mountedRef.current) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  const importBrowserProfile = (browser: DetectedBrowser, profileName: string) => {
    if (busyRef.current) return
    const target = { id: destination.id, label: destination.label }
    const profile = browser.profiles.find((candidate) => candidate.name === profileName)
    if (!profile) return
    void runImport(target, `${browser.label} (${profile.label})`, async () => browserSource(browser, profile.name))
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (!file || busyRef.current) return
    const target = { id: destination.id, label: destination.label }
    void runImport(target, 'JSON file', async () => {
      let contents: string
      try {
        contents = await file.text()
      } catch {
        throw new Error('Could not read the selected JSON file.')
      }
      let cookies: unknown
      try {
        cookies = JSON.parse(contents)
      } catch {
        throw new Error('The selected file must contain valid JSON.')
      }
      if (!Array.isArray(cookies)) throw new Error('The selected file must contain a JSON array of cookies.')
      if (cookies.length === 0) throw new Error('The selected file must contain at least one cookie.')
      return { kind: 'json', cookies }
    })
  }

  const available = imports?.available === true
  const currentDestination = activity && activity.status !== 'succeeded' && activity.status !== 'failed'
    ? activity.target
    : destination
  const activityLabel = activity?.status === 'reading'
    ? `Reading JSON file for ${activity.target.label}…`
    : activity?.status === 'confirming'
      ? `Confirming replacement for ${activity.target.label}…`
      : activity?.status === 'queued'
        ? `Queued for ${activity.target.label}`
        : activity?.status === 'running'
          ? `Importing to ${activity.target.label}`
          : null
  const result = activity?.status === 'succeeded' ? activity.result : undefined

  return <section className="cookie-import-panel" aria-label="Import Cookies">
    <h3>Import Cookies</h3>
    <p>Cookies are imported to managed Chrome profile <strong>{currentDestination.label}</strong>. Native browser sessions are separate.</p>
    <p>Google cookies are excluded from imports. Sign in to Google directly in Quirky.</p>
    {imports?.reason && <p>{imports.reason}</p>}
    {loadError && <p role="alert">{loadError}</p>}
    {error && <p role="alert">{error}</p>}
    {detectionError && <p role="alert">{detectionError}</p>}
    {activityLabel && <p role="status" aria-live="polite">{activityLabel}</p>}
    {activity?.status === 'failed' && <p role="status">Import failed for {activity.target.label}.</p>}
    {activity?.status === 'succeeded' && result && <div aria-label="Import summary" role="status">
      <h4>Import complete for {activity.target.label}</h4>
      <p>Source: {activity.sourceLabel}</p>
      <p>{result.importedCookies} imported, {result.skippedCookies} skipped, {result.totalCookies} total.</p>
      <ul>
        <li>{result.googleCookiesSkipped ?? 0} Google cookies skipped</li>
        <li>{result.partitionSkippedCookies ?? 0} partitioned cookies skipped</li>
      </ul>
      <p>Destination: managed Chrome profile {activity.target.label}. Native browser sessions remain separate.</p>
      {result.warning && <div aria-label="Import warnings">
        <p>Engine warning: {result.warning.code}</p>
        {result.warning.reasons?.map((reason, index) => <p key={`${index}-${reason}`}>{reason}</p>)}
      </div>}
    </div>}
    <div aria-label="Detected cookie sources">
      {detecting && <p role="status">Detecting installed browsers…</p>}
      {!detecting && !detectionError && browsers.length === 0 && <p>No supported browsers were found.</p>}
      {browsers.map((browser) => browser.profiles.length === 1
        ? <button
          key={browser.family}
          type="button"
          disabled={busy || !available}
          onClick={() => importBrowserProfile(browser, browser.profiles[0]!.name)}
        >From {browser.label}</button>
        : <fieldset key={browser.family}>
          <legend>{browser.label}</legend>
          {browser.profiles.length === 0
            ? <p>No profiles were found.</p>
            : browser.profiles.map((profile) => <button
              key={profile.name}
              type="button"
              disabled={busy || !available}
              onClick={() => importBrowserProfile(browser, profile.name)}
            >{browser.label} — {profile.label}</button>)}
        </fieldset>)}
    </div>
    <button type="button" disabled={busy || detecting} onClick={() => void detectSources()}>{detecting ? 'Refreshing browsers…' : 'Refresh browsers'}</button>
    <button type="button" disabled={busy || !available} onClick={() => setFileDialogOpen(true)}>From File</button>
    <button type="button" onClick={() => {
      void contextRef.current.executeCommand('command:quirky.browser/browserSettings').catch((cause: unknown) => {
        const message = errorMessage(cause, 'Browser Settings could not be opened.')
        reportError(message)
      })
    }}>Browser Settings…</button>
    {onHideHint && <button type="button" onClick={() => callbacksRef.current.onHideHint?.()}>Hide Hint</button>}
    {fileDialogOpen && <div role="dialog" aria-modal="true" aria-label="Import Cookies">
      <h4>Import Cookies</h4>
      <p>Choose a JSON file. Its selected bytes are read in this window and sent as cookie data to managed Chrome.</p>
      <label>Choose JSON file<input
        type="file"
        accept="application/json,.json"
        disabled={busy}
        onChange={handleFileChange}
      /></label>
      <button type="button" disabled={busy} onClick={() => setFileDialogOpen(false)}>Cancel</button>
    </div>}
  </section>
}
