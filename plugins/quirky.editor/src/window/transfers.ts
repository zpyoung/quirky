import { bytesToBase64, type UiPluginContext } from '@quirky/protocol'
import type { EditorBufferInfo, EditorSurfaceBuffer } from '../types'

export const INLINE_DRAFT_LIMIT = 128 * 1024
const TRANSFER_CHUNK_MAX = 64 * 1024
const encoder = new TextEncoder()

type TransferKind = 'draft' | 'createFile' | 'import'
type TransferBegin = { transferId: string; offset: 0; maxChunkBytes: number }
type TransferChunk = { action: 'chunk'; transferId: string; offset: number; data: string }
type TransferChunkResult = { transferId: string; offset: number }

export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const character of text) {
    const point = character.codePointAt(0)!
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return bytes
}

function* utf8Chunks(text: string, maxBytes: number): Generator<Uint8Array> {
  let start = 0
  let end = 0
  let bytes = 0
  for (const character of text) {
    const point = character.codePointAt(0)!
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes > 0 && bytes + width > maxBytes) {
      yield encoder.encode(text.slice(start, end))
      start = end
      bytes = 0
    }
    end += character.length
    bytes += width
  }
  if (end > start) yield encoder.encode(text.slice(start, end))
}

async function beginTransfer(
  context: UiPluginContext,
  details: { kind: TransferKind; bufferId?: string; expectedRevision?: number; worktree?: string; path?: string; name?: string; totalBytes: number }
): Promise<TransferBegin> {
  const result = await context.call('quirky.editor/transfer', { action: 'begin', ...details }) as TransferBegin
  if (typeof result.transferId !== 'string' || result.transferId === '' || !Number.isInteger(result.maxChunkBytes) || result.maxChunkBytes < 1 || result.maxChunkBytes > TRANSFER_CHUNK_MAX) {
    throw new Error('The editor transfer service returned invalid chunk limits.')
  }
  return result
}

async function sendChunk(context: UiPluginContext, transfer: TransferBegin, offset: number, bytes: Uint8Array): Promise<number> {
  const result = await context.call('quirky.editor/transfer', {
    action: 'chunk',
    transferId: transfer.transferId,
    offset,
    data: bytesToBase64(bytes)
  } satisfies TransferChunk) as TransferChunkResult
  if (result.transferId !== transfer.transferId || result.offset !== offset + bytes.byteLength) throw new Error('The editor transfer acknowledged an unexpected byte offset.')
  return result.offset
}

async function cancelTransfer(context: UiPluginContext, transferId: string): Promise<void> {
  await context.call('quirky.editor/transfer', { action: 'cancel', transferId }).catch(() => {})
}

async function uploadTextTransfer(
  context: UiPluginContext,
  transfer: TransferBegin,
  text: string,
  totalBytes: number
): Promise<void> {
  let offset = 0
  for (const chunk of utf8Chunks(text, transfer.maxChunkBytes)) {
    offset = await sendChunk(context, transfer, offset, chunk)
  }
  if (offset !== totalBytes) throw new Error('The editor transfer did not send the full UTF-8 document.')
}

export async function writeDraft(context: UiPluginContext, bufferId: string, content: string, expectedRevision: number): Promise<EditorBufferInfo> {
  const totalBytes = utf8ByteLength(content)
  if (totalBytes <= INLINE_DRAFT_LIMIT) {
    return await context.call('quirky.editor/draft', { bufferId, content, expectedRevision }) as EditorBufferInfo
  }
  if (totalBytes > 50 * 1024 * 1024) throw new Error('The editor draft exceeds the 50 MiB transfer limit.')
  const transfer = await beginTransfer(context, { kind: 'draft', bufferId, expectedRevision, totalBytes })
  try {
    await uploadTextTransfer(context, transfer, content, totalBytes)
    return await context.call('quirky.editor/transfer', { action: 'commit', transferId: transfer.transferId }) as EditorBufferInfo
  } catch (reason) {
    await cancelTransfer(context, transfer.transferId)
    throw reason
  }
}

export async function createFileTransfer(context: UiPluginContext, worktree: string, path: string, content: string): Promise<unknown> {
  const totalBytes = utf8ByteLength(content)
  const transfer = await beginTransfer(context, { kind: 'createFile', worktree, path, totalBytes })
  try {
    await uploadTextTransfer(context, transfer, content, totalBytes)
    return await context.call('quirky.editor/transfer', { action: 'commit', transferId: transfer.transferId })
  } catch (reason) {
    await cancelTransfer(context, transfer.transferId)
    throw reason
  }
}

export async function importFileTransfer(context: UiPluginContext, worktree: string, directory: string, file: File): Promise<{ path?: string; paths?: string[] }> {
  if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} exceeds the 50 MiB per-file import limit.`)
  const transfer = await beginTransfer(context, {
    kind: 'import',
    worktree,
    path: directory,
    name: file.name,
    totalBytes: file.size
  })
  try {
    let offset = 0
    while (offset < file.size) {
      const end = Math.min(file.size, offset + transfer.maxChunkBytes)
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer())
      offset = await sendChunk(context, transfer, offset, bytes)
    }
    return await context.call('quirky.editor/transfer', { action: 'commit', transferId: transfer.transferId }) as { path?: string; paths?: string[] }
  } catch (reason) {
    await cancelTransfer(context, transfer.transferId)
    throw reason
  }
}

export async function readText(
  context: UiPluginContext,
  bufferId: string,
  kind: 'content' | 'draft' | 'disk',
  contentRevision: number,
  diskSignature?: string
): Promise<string> {
  if (kind === 'disk' && !diskSignature) throw new Error('A disk signature is required to read external disk text.')
  const chunks: string[] = []
  let offset = 0
  for (;;) {
    const result = await context.call('quirky.editor/read', {
      bufferId,
      action: 'text',
      kind,
      offset,
      length: TRANSFER_CHUNK_MAX,
      contentRevision,
      ...(kind === 'disk' ? { diskSignature } : {})
    }) as { text: string; offset: number; nextOffset: number; eof: boolean; contentRevision: number }
    if (result.contentRevision !== contentRevision || result.offset !== offset || result.nextOffset <= offset && !result.eof) {
      throw new Error('The visible document changed while its text was loading. Retry to read the latest revision.')
    }
    chunks.push(result.text)
    offset = result.nextOffset
    if (result.eof) return chunks.join('')
  }
}
export async function hydrateBuffer(context: UiPluginContext, info: EditorBufferInfo): Promise<EditorSurfaceBuffer> {
  const content = typeof info.content === 'string'
    ? info.content
    : await readText(context, info.id, 'content', info.contentRevision)
  const draft = info.draftLength === null
    ? null
    : typeof info.draft === 'string'
      ? info.draft
      : await readText(context, info.id, 'draft', info.contentRevision)
  if (content.length !== info.contentLength || (draft !== null && draft.length !== info.draftLength)) {
    throw new Error('The editor returned text with an unexpected UTF-16 length.')
  }
  return { ...info, content, draft }
}
export async function hydrateDiskContent(context: UiPluginContext, info: EditorBufferInfo): Promise<string | null> {
  if (info.diskContentLength === null) return null
  const diskContent = typeof info.diskContent === 'string'
    ? info.diskContent
    : await readText(context, info.id, 'disk', info.contentRevision, info.diskSignature ?? undefined)
  if (diskContent.length !== info.diskContentLength) throw new Error('The editor returned disk text with an unexpected UTF-16 length.')
  return diskContent
}
export async function importFiles(context: UiPluginContext, worktree: string, directory: string, files: File[]): Promise<string[]> {
  if (files.length > 256) throw new Error('Import is limited to 256 files.')
  let totalBytes = 0
  let metadataBytes = 0
  for (const file of files) {
    if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} exceeds the 50 MiB per-file import limit.`)
    totalBytes += file.size
    metadataBytes += utf8ByteLength(file.name)
    if (totalBytes > 50 * 1024 * 1024) throw new Error('Import exceeds the 50 MiB aggregate byte limit.')
    if (metadataBytes > 256 * 1024) throw new Error('Import file names exceed the 256 KiB metadata limit.')
    if (file.name.includes('/') || file.name.includes('\\') || file.name === '.' || file.name === '..') throw new Error(`Unsafe import file name: ${file.name}`)
  }
  const paths: string[] = []
  for (const file of files) {
    const imported = await importFileTransfer(context, worktree, directory || '.', file)
    if (imported.paths?.length) paths.push(...imported.paths)
    else if (imported.path) paths.push(imported.path)
  }
  return paths
}
