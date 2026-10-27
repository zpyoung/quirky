import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

export const MAX_CONFIG_BYTES = 4 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024

export class BoundedConfigReadError extends Error {}

/** Opens one config file descriptor and reads at most one byte beyond the shared size limit. */
export async function readBoundedConfig(path: string): Promise<Buffer> {
  let file: FileHandle | undefined
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const initialStat = await file.stat()
    if (!initialStat.isFile()) throw new BoundedConfigReadError('configuration file must be a regular file')
    if (initialStat.size > MAX_CONFIG_BYTES) {
      throw new BoundedConfigReadError(`configuration file exceeds ${MAX_CONFIG_BYTES} bytes`)
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_CONFIG_BYTES + 1 - totalBytes))
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      if (totalBytes > MAX_CONFIG_BYTES) {
        throw new BoundedConfigReadError(`configuration file exceeds ${MAX_CONFIG_BYTES} bytes`)
      }
      chunks.push(chunk.subarray(0, bytesRead))
    }

    if ((await file.stat()).size > MAX_CONFIG_BYTES) {
      throw new BoundedConfigReadError(`configuration file exceeds ${MAX_CONFIG_BYTES} bytes`)
    }
    return Buffer.concat(chunks, totalBytes)
  } finally {
    await file?.close()
  }
}
