import { realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
import type ts from 'typescript'

/**
 * Returns `source` with `data-quirky-source="<repo-relative-path>:<line>"` added to every intrinsic JSX element
 * (lowercase tags, never components or fragments), so a rendered element can be traced to its source line.
 * Insertions never add a newline, which keeps every line number in the output equal to the original.
 * Throws, naming `file`, when the source does not parse.
 */
export async function addSourceAttributes(source: string, file: string, repoRoot: string): Promise<string> {
  // typescript stays out of the release build, which never reaches this function
  const ts = (await import('typescript')).default
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const [problem] = (sourceFile as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics
  if (problem) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(problem.start ?? 0)
    throw new Error(`${file}:${line + 1}: ${ts.flattenDiagnosticMessageText(problem.messageText, '\n')}`)
  }

  // jsx attribute strings have no backslash escapes, only html entities
  const path = relative(repoRoot, file).split(sep).join('/').replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  const insertions: { at: number; text: string }[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const { tagName, attributes } = node
      const intrinsic = ts.isIdentifier(tagName) && (/^[a-z]/.test(tagName.text) || tagName.text.includes('-'))
      const tagged = attributes.properties.some(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === 'data-quirky-source'
      )
      if (intrinsic && !tagged) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        // after the last attribute, so a spread earlier in the list cannot override it
        insertions.push({ at: attributes.end, text: ` data-quirky-source="${path}:${line}"` })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  let output = source
  for (const { at, text } of insertions.sort((a, b) => b.at - a.at)) output = output.slice(0, at) + text + output.slice(at)
  return output
}

/** Bun build plugin that applies `addSourceAttributes` to every `.tsx` file under `directories`. */
export function jsxSourcePlugin(repoRoot: string, directories: string[]): Bun.BunPlugin {
  // bun reports resolved paths, and tmpdirs on macOS sit behind a symlink
  const roots = directories.map((directory) => realpathSync(directory) + sep)
  return {
    name: 'quirky-jsx-source',
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
        if (!roots.some((root) => path.startsWith(root))) return undefined
        const source = await Bun.file(path).text()
        return { contents: await addSourceAttributes(source, path, repoRoot), loader: 'tsx' }
      })
    }
  }
}
