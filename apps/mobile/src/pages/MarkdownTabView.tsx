import { useCallback, useEffect, useRef, useState } from 'react'
import type { MobileMarkdownDocument } from '@quirky/protocol'
import type { MobilePageBridge } from '../contracts'
import { errorMessage, PageError, PageModal } from './components'
import { MarkdownPreview } from './MarkdownPreview'

type MarkdownDocument = MobileMarkdownDocument & { relativePath: string }
type MobileTab = { tabId: string; worktreeId: string; kind: 'markdown'; title: string; dirty: boolean }

type Props = {
  bridge: MobilePageBridge
  worktreeId: string
  tab: MobileTab
  canMutate: boolean
  canCopy: boolean
  onTabsChanged(): void
  onClosed(): void
}

const MAX_MARKDOWN_BYTES = 64 * 1024
const textEncoder = new TextEncoder()

export function MarkdownTabView({ bridge, worktreeId, tab, canMutate, canCopy, onTabsChanged, onClosed }: Props) {
  const [documentValue, setDocumentValue] = useState<MarkdownDocument | null>(null)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'source' | 'preview'>('source')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(tab.title)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [closePrompt, setClosePrompt] = useState(false)
  const [refreshPrompt, setRefreshPrompt] = useState(false)
  const mounted = useRef(false)
  const textRef = useRef(text)
  const documentRef = useRef<MarkdownDocument | null>(null)
  const revisionRef = useRef<number | null>(null)
  const pendingText = useRef<string | null>(null)
  const writeFlight = useRef<Promise<void> | null>(null)
  const writeErrorRef = useRef<string | null>(null)

  useEffect(() => {
    mounted.current = true
    let active = true
    setLoading(true)
    setError(null)
    void bridge.call<MarkdownDocument>('quirky.mobile/markdownRead', { worktree: worktreeId, tabId: tab.tabId }).then((next) => {
      if (!active) return
      documentRef.current = next
      revisionRef.current = next.revision
      textRef.current = next.text
      setDocumentValue(next)
      setText(next.text)
      setWriteError(null)
      writeErrorRef.current = null
    }).catch((cause) => {
      if (active) setError(errorMessage(cause, 'Could not read this Markdown tab.'))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
      mounted.current = false
    }
  }, [bridge, tab.tabId, worktreeId])

  const queueWrite = useCallback((value: string) => {
    pendingText.current = value
    if (writeFlight.current) return
    const flight = (async () => {
      while (pendingText.current !== null) {
        const nextText = pendingText.current
        pendingText.current = null
        const expectedRevision = revisionRef.current
        if (expectedRevision === null) throw new Error('The Markdown tab is not ready to edit.')
        const accepted = await bridge.call<MarkdownDocument>('quirky.mobile/markdownWrite', {
          worktree: worktreeId, tabId: tab.tabId, text: nextText, expectedRevision
        })
        revisionRef.current = accepted.revision
        documentRef.current = accepted
        if (mounted.current) {
          setDocumentValue((current) => current ? { ...current, revision: accepted.revision, dirty: accepted.dirty, readOnly: accepted.readOnly } : accepted)
          setWriteError(null)
          setError(null)
        }
        writeErrorRef.current = null
      }
    })().catch((cause: unknown) => {
      pendingText.current = null
      const message = errorMessage(cause, 'The phone draft could not be sent to the desktop.')
      writeErrorRef.current = message
      if (mounted.current) setWriteError(message)
    }).finally(() => {
      writeFlight.current = null
      if (pendingText.current !== null) queueWrite(pendingText.current)
    })
    writeFlight.current = flight
  }, [bridge, tab.tabId, worktreeId])

  const flushWrites = useCallback(async () => {
    while (writeFlight.current) await writeFlight.current
  }, [])

  const acceptDocument = useCallback((next: MarkdownDocument) => {
    documentRef.current = next
    revisionRef.current = next.revision
    textRef.current = next.text
    writeErrorRef.current = null
    if (mounted.current) {
      setDocumentValue(next)
      setText(next.text)
      setWriteError(null)
    }
  }, [])

  const refreshDocument = useCallback(async (discardPhoneDraft: boolean) => {
    if (!canMutate || busy) return
    setBusy(true)
    setError(null)
    try {
      await flushWrites()
      if (writeErrorRef.current && !discardPhoneDraft) {
        setRefreshPrompt(true)
        return
      }
      const action = await bridge.call<{ tabId: string; closed: boolean }>('quirky.mobile/sessionTabAction', {
        worktree: worktreeId, tabId: tab.tabId, action: 'refresh'
      })
      if (action.closed) throw new Error('The desktop closed this tab while it was refreshing.')
      const next = await bridge.call<MarkdownDocument>('quirky.mobile/markdownRead', { worktree: worktreeId, tabId: tab.tabId })
      acceptDocument(next)
      setRefreshPrompt(false)
      setNotice('Markdown refreshed from the desktop editor.')
      onTabsChanged()
    } catch (cause) {
      setError(errorMessage(cause, 'Could not refresh this Markdown tab.'))
    } finally {
      setBusy(false)
    }
  }, [acceptDocument, bridge, busy, canMutate, flushWrites, onTabsChanged, tab.tabId, worktreeId])

  const save = async () => {
    if (!canMutate || busy || !documentValue || documentValue.readOnly) return
    setBusy(true)
    setError(null)
    try {
      await flushWrites()
      if (writeErrorRef.current) throw new Error(writeErrorRef.current)
      const expectedRevision = revisionRef.current
      if (expectedRevision === null) throw new Error('The Markdown tab is not ready to save.')
      const saved = await bridge.call<MarkdownDocument>('quirky.mobile/markdownSave', {
        worktree: worktreeId, tabId: tab.tabId, expectedRevision
      })
      acceptDocument(saved)
      setNotice(saved.dirty ? 'The editor retained a newer draft; refresh before saving again.' : 'Markdown saved on the desktop.')
      onTabsChanged()
    } catch (cause) {
      setError(errorMessage(cause, 'Could not save this Markdown tab.'))
    } finally {
      setBusy(false)
    }
  }

  const copyNote = async () => {
    if (!canCopy || busy) return
    setBusy(true)
    setError(null)
    try {
      await bridge.native.clipboardWrite(textRef.current)
      setNotice('Markdown text copied.')
    } catch (cause) {
      setError(errorMessage(cause, 'Could not copy Markdown text.'))
    } finally {
      setBusy(false)
    }
  }

  const copyPath = async () => {
    if (!canCopy || !documentValue || busy) return
    setBusy(true)
    setError(null)
    try {
      await bridge.native.clipboardWrite(documentValue.relativePath)
      setNotice('Worktree-relative path copied.')
    } catch (cause) {
      setError(errorMessage(cause, 'Could not copy the Markdown path.'))
    } finally {
      setBusy(false)
    }
  }

  const rename = async () => {
    if (!canMutate || busy) return
    const name = renameValue.trim()
    if (!name || name.length > 128) {
      setRenameError('Enter a name between 1 and 128 characters.')
      return
    }
    setBusy(true)
    setRenameError(null)
    try {
      await bridge.call('quirky.mobile/sessionTabAction', { worktree: worktreeId, tabId: tab.tabId, action: 'rename', name })
      setDocumentValue((current) => current ? { ...current, title: name } : current)
      setRenameOpen(false)
      onTabsChanged()
    } catch (cause) {
      setRenameError(errorMessage(cause, 'Could not rename this Markdown tab.'))
    } finally {
      setBusy(false)
    }
  }

  const close = async (discard: boolean) => {
    if (!canMutate || busy) return
    setBusy(true)
    setError(null)
    try {
      await flushWrites()
      if (writeErrorRef.current && !discard) {
        setClosePrompt(true)
        return
      }
      const result = await bridge.call<{ tabId: string; closed: boolean }>('quirky.mobile/sessionTabAction', {
        worktree: worktreeId, tabId: tab.tabId, action: 'close', ...(discard ? { discard: true } : {})
      })
      if (result.closed) {
        setClosePrompt(false)
        onClosed()
      } else {
        setClosePrompt(true)
      }
    } catch (cause) {
      setError(errorMessage(cause, 'Could not close this Markdown tab.'))
    } finally {
      setBusy(false)
    }
  }

  const handleTextChange = (value: string) => {
    if (textEncoder.encode(value).byteLength > MAX_MARKDOWN_BYTES) {
      const message = 'Markdown text exceeds the phone limit of 64 KiB.'
      setError(message)
      return
    }
    textRef.current = value
    setText(value)
    setError(null)
    queueWrite(value)
  }

  return (
    <section className="qp-markdown-tab" aria-label={`Markdown tab ${documentValue?.title ?? tab.title}`}>
      <header className="qp-dock-row" style={{ flexWrap: 'wrap' }}>
        <strong style={{ flex: '1 1 120px', minWidth: 0, overflowWrap: 'anywhere' }}>{documentValue?.title ?? tab.title}</strong>
        <button className="qp-button" type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>Source</button>
        <button className="qp-button" type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>Preview</button>
      </header>
      <div className="qp-dock-row" style={{ flexWrap: 'wrap' }}>
        <button className="qp-button qp-button--primary" type="button" disabled={!canMutate || busy || !documentValue || documentValue.readOnly} onClick={() => void save()}>{busy ? 'Working…' : 'Save'}</button>
        <button className="qp-button" type="button" disabled={!canCopy || busy || !documentValue} onClick={() => void copyNote()}>Copy note</button>
        <button className="qp-button" type="button" disabled={!canCopy || busy || !documentValue} onClick={() => void copyPath()}>Copy path</button>
        <button className="qp-button" type="button" disabled={!canMutate || busy} onClick={() => { setRenameValue(documentValue?.title ?? tab.title); setRenameError(null); setRenameOpen(true) }}>Rename</button>
        <button className="qp-button" type="button" disabled={!canMutate || busy} onClick={() => void refreshDocument(false)}>Refresh</button>
        <button className="qp-button qp-button--danger" type="button" disabled={!canMutate || busy} onClick={() => void close(false)}>Close tab</button>
        <span className="qp-count" role="status">{loading ? 'Loading…' : documentValue?.readOnly ? 'Read-only' : documentValue?.dirty ? 'Unsaved editor draft' : 'Saved'}</span>
      </div>
      {writeError && <PageError>{writeError} Refresh to read the current desktop revision before continuing.</PageError>}
      {error && <PageError>{error}</PageError>}
      {notice && <div className="qp-terminal-stale" role="status">{notice}</div>}
      {loading ? <div className="qp-session-empty qp-empty">Reading the actual editor buffer…</div> : mode === 'preview' ? (
        <div className="qp-content" style={{ flex: '1 1 auto', minHeight: 120, maxHeight: '50dvh', overflow: 'auto', overflowWrap: 'anywhere' }}>
          {documentValue ? <MarkdownPreview text={text} /> : null}
        </div>
      ) : (
        <label className="qp-form-field" style={{ flex: '1 1 auto', minHeight: 140 }}>
          Markdown source
          <textarea aria-label="Markdown source" spellCheck={false} disabled={!canMutate || !documentValue || documentValue.readOnly}
            value={text} onChange={(event) => handleTextChange(event.currentTarget.value)}
            style={{ minHeight: 140, height: 'min(42dvh, 420px)', resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, monospace', whiteSpace: 'pre' }} />
        </label>
      )}

      {renameOpen && <PageModal title="Rename Markdown tab" labelledBy="qp-rename-markdown-title" onClose={() => { if (!busy) setRenameOpen(false) }} footer={
        <>
          <button className="qp-button" type="button" disabled={busy} onClick={() => setRenameOpen(false)}>Cancel</button>
          <button className="qp-button qp-button--primary" type="button" disabled={busy} onClick={() => void rename()}>Save name</button>
        </>
      }>
        <label className="qp-form-field">Tab name<input aria-label="Tab name" maxLength={128} value={renameValue} onChange={(event) => setRenameValue(event.currentTarget.value)} /></label>
        {renameError && <PageError>{renameError}</PageError>}
      </PageModal>}

      {closePrompt && <PageModal title="Unsaved Markdown draft" labelledBy="qp-close-markdown-title" onClose={() => { if (!busy) setClosePrompt(false) }} footer={
        <>
          <button className="qp-button" type="button" disabled={busy} onClick={() => setClosePrompt(false)}>Keep editing</button>
          <button className="qp-button qp-button--danger" type="button" disabled={busy || !canMutate} onClick={() => void close(true)}>Discard draft and close</button>
        </>
      }>
        <p className="qp-dialog-copy">This actual editor buffer has unsaved changes. Closing is cancelled until you explicitly discard them.</p>
        {canCopy && <button className="qp-button" type="button" disabled={busy} onClick={() => void copyNote()}>Copy phone text before closing</button>}
      </PageModal>}

      {refreshPrompt && <PageModal title="Refresh Markdown from desktop?" labelledBy="qp-refresh-markdown-title" onClose={() => { if (!busy) setRefreshPrompt(false) }} footer={
        <>
          <button className="qp-button" type="button" disabled={busy} onClick={() => setRefreshPrompt(false)}>Keep phone text</button>
          <button className="qp-button qp-button--danger" type="button" disabled={busy || !canMutate} onClick={() => void refreshDocument(true)}>Reload desktop text</button>
        </>
      }>
        <p className="qp-dialog-copy">The phone text has not been accepted by the editor. Reloading replaces it with the current desktop buffer.</p>
      </PageModal>}
    </section>
  )
}
