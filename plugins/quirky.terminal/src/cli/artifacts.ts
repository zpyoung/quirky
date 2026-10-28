import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import type { CliContext, CliModule, TerminalArtifactResult } from '@quirky/protocol'
import { TERMINAL_ARTIFACT_TEXT_BYTES } from '@quirky/protocol'

type Action = 'list' | 'preview' | 'refresh' | 'save'

const allowedFlags = ['artifact-id', 'grant', 'revision', 'content-file']
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function readContentFile(path: string, ctx: CliContext): string {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error) {
    throw ctx.fail(`could not open content file: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const initial = fstatSync(fd)
    if (!initial.isFile()) throw ctx.fail('content file must be a regular file')
    if (initial.size > TERMINAL_ARTIFACT_TEXT_BYTES) throw ctx.fail(`content file exceeds ${TERMINAL_ARTIFACT_TEXT_BYTES} bytes`)
    const bytes = Buffer.allocUnsafe(initial.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    const final = fstatSync(fd)
    if (offset !== bytes.length || final.size !== initial.size || final.dev !== initial.dev || final.ino !== initial.ino ||
      final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) throw ctx.fail('content file changed while it was being read')
    let content: string
    try {
      content = decoder.decode(bytes)
    } catch {
      throw ctx.fail('content file must contain valid UTF-8 text')
    }
    if (content.includes('\0')) throw ctx.fail('content file must contain text, not binary data')
    return content
  } finally {
    closeSync(fd)
  }
}

function textResult(result: TerminalArtifactResult, ctx: CliContext): string {
  switch (result.kind) {
    case 'listed': {
      if (result.artifacts.length === 0) {
        return result.limited ? 'No file paths found in the bounded scan; results may be incomplete.' : 'No file paths found in terminal output.'
      }
      const table = ctx.format.table(
        ['ARTIFACT ID', 'NAME', 'PATH', 'GRANT'],
        result.artifacts.map((artifact) => [artifact.artifactId, artifact.name, artifact.path, artifact.grant])
      )
      return result.limited ? `${table}\n[results limited]` : table
    }
    case 'preview': {
      if (result.format === 'image') {
        return `${result.artifact.path}\n${result.image?.mime ?? 'image'} preview (${result.bytes} bytes; read-only)`
      }
      if (result.format === 'binary') return `${result.artifact.path}\nBinary file (${result.bytes} bytes; read-only).`
      const status = `${result.writable ? 'writable' : 'read-only'}${result.truncated ? '; truncated' : ''}; ${result.bytes} bytes`
      return `${result.artifact.path}\n${result.content}${result.content.endsWith('\n') ? '' : '\n'}[${status}; revision ${result.revision}]`
    }
    case 'refreshed':
      return `refreshed ${result.artifact.name}\nartifact-id ${result.artifact.artifactId}\ngrant ${result.artifact.grant}\nexpires at ${new Date(result.artifact.expiresAt).toISOString()}`
    case 'saved':
      return `saved ${result.artifact.path}\nrevision ${result.revision}`
    case 'refused':
      return `refused (${result.reason}): ${result.guidance}`
  }
}

export const artifactCommands: CliModule['commands'] = {
  async artifacts(args, ctx) {
    if (args.positionals.length !== 3) throw ctx.usage('expected <action> <worktree> <session>')
    const [actionText, worktree, session] = args.positionals
    if (actionText !== 'list' && actionText !== 'preview' && actionText !== 'refresh' && actionText !== 'save') {
      throw ctx.usage('<action> must be list, preview, refresh or save')
    }
    const action: Action = actionText
    if (!worktree || !session) throw ctx.usage('expected <action> <worktree> <session>')
    const unexpected = Object.keys(args.flags).find((flag) => !allowedFlags.includes(flag))
    if (unexpected) throw ctx.usage(`unexpected flag --${unexpected}`)
    const requiredFlags = action === 'list' ? [] : action === 'save' ? allowedFlags : ['artifact-id', 'grant']
    const invalidFlag = Object.keys(args.flags).find((flag) => !requiredFlags.includes(flag))
    if (invalidFlag) throw ctx.usage(`--${invalidFlag} is not used with ${action}`)
    const artifactId = args.flags['artifact-id']
    const grant = args.flags.grant
    const revision = args.flags.revision
    const contentFile = args.flags['content-file']
    if (action !== 'list' && (typeof artifactId !== 'string' || artifactId.length === 0 || typeof grant !== 'string' || grant.length === 0)) {
      throw ctx.usage(`${action} requires --artifact-id and --grant`)
    }
    if (action === 'save' && (typeof revision !== 'string' || revision.length === 0 || typeof contentFile !== 'string' || contentFile.length === 0)) {
      throw ctx.usage('save requires --revision and --content-file')
    }
    const content = action === 'save' ? readContentFile(contentFile as string, ctx) : undefined
    const params = {
      action,
      worktree,
      session,
      ...(action === 'list' ? {} : { artifactId: artifactId as string, grant: grant as string }),
      ...(action === 'save' ? { expectedRevision: revision as string, content: content as string } : {})
    }
    const result = await ctx.call('quirky.terminal/artifacts', params) as TerminalArtifactResult
    ctx.out.result(result, () => textResult(result, ctx))
  }
}
