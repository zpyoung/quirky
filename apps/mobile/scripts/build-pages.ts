import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { MobileBundleAsset, MobileBundleManifest } from '../src/contracts'
import { MOBILE_SHELL_VERSION } from '../src/contracts'
import { PAGE_BUNDLE_ROUTES, validateBundleManifest } from '../src/shell/generation'

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function buildIdFor(assets: readonly MobileBundleAsset[]): string {
  const canonical = `v=1\nshellVersion=${MOBILE_SHELL_VERSION}\n${[...assets]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((asset) => `${asset.path}\0${asset.bytes}\0${asset.sha256}\0${asset.contentType}\n`)
    .join('')}`
  return sha256(new TextEncoder().encode(canonical))
}

function assetPaths(directory: string, relative = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error('mobile page build emitted a symbolic link')
    const path = relative ? `${relative}/${entry.name}` : entry.name
    const absolute = join(directory, entry.name)
    return entry.isDirectory() ? assetPaths(absolute, path) : [path]
  })
}

function contentType(path: string): string {
  const type = CONTENT_TYPES[extname(path).toLowerCase()]
  if (!type) throw new Error(`mobile page build emitted an unsupported asset type: ${path}`)
  return type
}

function indexHtml(cssPaths: readonly string[]): string {
  const styles = cssPaths.map((path) => `<link rel="stylesheet" href="/${path}">`).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self' blob:; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; navigate-to 'self'">
<title>Quirky Mobile</title>
${styles}
</head>
<body>
<div id="root"></div>
<script defer src="/page.js"></script>
</body>
</html>
`
}

function atomicReplace(staging: string, outputDirectory: string): void {
  const parent = dirname(outputDirectory)
  let backup: string | undefined
  if (existsSync(outputDirectory)) {
    backup = mkdtempSync(join(parent, '.mobile-pages-previous-'))
    rmSync(backup, { recursive: true, force: true })
    renameSync(outputDirectory, backup)
  }
  try {
    renameSync(staging, outputDirectory)
  } catch (error) {
    if (backup && existsSync(backup) && !existsSync(outputDirectory)) renameSync(backup, outputDirectory)
    throw error
  }
  if (backup) rmSync(backup, { recursive: true, force: true })
}

export async function buildMobilePages(
  repositoryRoot = join(import.meta.dir, '..', '..', '..'),
  outputDirectory = join(repositoryRoot, 'plugins', 'quirky.mobile', 'assets', 'mobile')
): Promise<MobileBundleManifest> {
  const entrypoint = join(repositoryRoot, 'apps', 'mobile', 'web-entry', 'main.tsx')
  if (!existsSync(entrypoint)) throw new Error(`mobile page entrypoint is missing: ${entrypoint}`)
  const parent = dirname(outputDirectory)
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, '.mobile-pages-stage-'))
  try {
    const built = await Bun.build({
      entrypoints: [entrypoint],
      outdir: staging,
      target: 'browser',
      minify: true,
      splitting: false,
      sourcemap: 'none',
      naming: { entry: 'page.[ext]', chunk: 'chunk-[name]-[hash].[ext]', asset: 'asset-[name]-[hash].[ext]' },
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    if (!built.success) throw new Error(`mobile page bundle build failed:\n${built.logs.map((log) => String(log)).join('\n')}`)
    const emitted = assetPaths(staging).sort()
    if (!emitted.includes('page.js')) throw new Error('mobile page build did not emit page.js')
    const cssPaths = emitted.filter((path) => extname(path).toLowerCase() === '.css')
    writeFileSync(join(staging, 'index.html'), indexHtml(cssPaths))
    const assets: MobileBundleAsset[] = assetPaths(staging).sort().map((path) => {
      const bytes = new Uint8Array(readFileSync(join(staging, path)))
      return { path, bytes: bytes.byteLength, sha256: sha256(bytes), contentType: contentType(path) }
    })
    const totalBytes = assets.reduce((total, asset) => total + asset.bytes, 0)
    const manifest = validateBundleManifest({
      v: 1,
      shellVersion: MOBILE_SHELL_VERSION,
      buildId: buildIdFor(assets),
      assets,
      totalBytes,
      routes: PAGE_BUNDLE_ROUTES.map((route) => ({
        kind: route.kind,
        path: route.path,
        grants: [...route.grants]
      }))
    })
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
    atomicReplace(staging, outputDirectory)
    return manifest
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const repositoryRoot = join(import.meta.dir, '..', '..', '..')
  const manifest = await buildMobilePages(repositoryRoot)
  console.log(`built mobile pages ${manifest.buildId} (${manifest.totalBytes} bytes, ${manifest.assets.length} assets)`)
}
