#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  QUIRKYD_NODE_PTY_DIR,
  QUIRKYD_NODE_RUNTIME_MARKER_FILENAME,
  QUIRKYD_SERVER_TARGET_FILENAME,
  QUIRKYD_TEMPLATE_MANIFEST_FILENAME,
  QUIRKYD_TEMPLATE_TARGETS_DIR,
  quirkydNodePtySlotFiles,
  quirkydTemplateCommonFilenames,
  quirkydTemplateTargetFilenames
} from '../../src/shared/quirkyd-artifacts.ts'
import { quirkydAgentBrowserNativeName } from '../../src/shared/quirkyd-agent-browser-name.ts'
import {
  COMPAT_SERVER_TARGET_BASES,
  COMPAT_SERVER_TARGETS,
  QUIRKYD_TEMPLATE_TARGETS,
  pinnedNodeRuntimeAsset
} from '../../src/shared/node-runtime-pin.ts'
import { QUIRKYD_PREBUILDS_DIR } from './build-quirkyd-prebuilds.mjs'
import {
  COMPAT_SLOT_ADDONS,
  findCompatAddonGaps,
  findSlotProblems,
  readManifest
} from './quirkyd-prebuild-slot-contents.mjs'
import { runProcessSync } from '@quirky/process-host'
import { verifyPackagedQuirkydTemplate } from './verify-packaged-quirkyd-template.cjs'
import { readQuirkydMobileWebAssetFilenames } from './quirkyd-mobile-web-bundle.mjs'
import { assertNotDarkBuild, darkBuildMarkers } from '../dark-build-switches.cjs'

const root = resolve(import.meta.dirname, '../..')
const outputDir = join(root, 'out', 'quirkyd-template')
const buildDir = join(root, 'out', '.quirkyd-template-build')

function isExecutable(filename) {
  return /(?:^|\/)(?:rg|spawn-helper)$/.test(filename)
}

function copy(source, destination, executable = false) {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  if (executable && process.platform !== 'win32') {
    chmodSync(destination, 0o755)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** One full package per target; each needs that target's node-pty slot in out/quirkyd-prebuilds. */
function buildTargetPackage(target) {
  const packageDir = join(buildDir, target, 'quirkyd')
  const result = runProcessSync({
    program: process.execPath,
    args: [
      join(root, 'config/scripts/build-quirkyd-node.mjs'),
      '--target',
      target,
      '--out-dir',
      packageDir
    ],
    cwd: root,
    // Why no agent-browser: the template ships inside every desktop build (design D2), and seven
    // ~10 MB browsers would outweigh everything else in it; a slot without one reports no browser.
    env: { ...process.env, QUIRKYD_OMIT_AGENT_BROWSER: '1' },
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`quirkyd ${target} package build failed with exit ${result.code ?? 'unknown'}`)
  }
  return packageDir
}

function stageTarget(target, packageDir) {
  const destination = join(outputDir, QUIRKYD_TEMPLATE_TARGETS_DIR, target)
  const files = {}
  for (const filename of quirkydTemplateTargetFilenames(target)) {
    const staged = join(destination, ...filename.split('/'))
    copy(join(packageDir, ...filename.split('/')), staged, isExecutable(filename))
    files[filename] = sha256(staged)
  }
  const browserName = quirkydAgentBrowserNativeName(
    target.split('-')[0],
    target.split('-')[1],
    target.endsWith('-musl') ? 'musl' : 'glibc'
  )
  const browserSource = join(packageDir, browserName)
  if (!existsSync(browserSource)) {
    return { files }
  }
  const browserDestination = join(destination, browserName)
  copy(browserSource, browserDestination, true)
  return { files, browserName, browserSha256: sha256(browserDestination) }
}

/**
 * `--targets a,b` builds a partial template for CI jobs that can fill only some prebuild slots
 * (the SSH hostile-host matrix). A shipped template always carries every target.
 */
export function requestedTemplateTargets(argv = process.argv) {
  const index = argv.indexOf('--targets')
  if (index === -1) {
    return QUIRKYD_TEMPLATE_TARGETS
  }
  const targets = (argv[index + 1] ?? '').split(',').filter(Boolean)
  const unknown = targets.filter((target) => !QUIRKYD_TEMPLATE_TARGETS.includes(target))
  if (targets.length === 0 || unknown.length > 0) {
    throw new Error(
      `--targets needs a comma-separated subset of ${QUIRKYD_TEMPLATE_TARGETS.join(',')}; got ${argv[index + 1] ?? 'nothing'}`
    )
  }
  return [...new Set(targets)]
}

/**
 * A compat target (design D6 rung B) is its base target's package with the compat slot's addons
 * and runtime marker swapped in; everything else is target-independent or libc-static.
 * Omitted, not failed, when this build has no compat slot: rung B then refuses as unavailable.
 */
function stageCompatTarget(compat, basePackageDir) {
  const problems = findSlotProblems(readManifest(QUIRKYD_PREBUILDS_DIR), QUIRKYD_PREBUILDS_DIR, [
    compat
  ])
  if (problems.length > 0) {
    process.stdout.write(
      `[build-quirkyd-template] skipping compat target ${compat}: ${problems.join('; ')}\n`
    )
    return null
  }
  const destination = join(outputDir, QUIRKYD_TEMPLATE_TARGETS_DIR, compat)
  const slotFiles = new Map([
    ...quirkydNodePtySlotFiles(compat).map((file) => [
      `${QUIRKYD_NODE_PTY_DIR}/build/Release/${file}`,
      join(QUIRKYD_PREBUILDS_DIR, compat, ...file.split('/'))
    ]),
    ...Object.entries(COMPAT_SLOT_ADDONS).map(([file, shipped]) => [
      shipped,
      join(QUIRKYD_PREBUILDS_DIR, compat, ...file.split('/'))
    ])
  ])
  // Why fatal: the base binary would pass every check here and fail only on a compat host.
  const gaps = findCompatAddonGaps(quirkydTemplateTargetFilenames(compat), slotFiles)
  if (gaps.length > 0) {
    throw new Error(`compat target ${compat} would ship base-target addons: ${gaps.join(', ')}`)
  }
  const files = {}
  for (const filename of quirkydTemplateTargetFilenames(compat)) {
    const staged = join(destination, ...filename.split('/'))
    if (filename === QUIRKYD_SERVER_TARGET_FILENAME) {
      mkdirSync(dirname(staged), { recursive: true })
      writeFileSync(staged, `${compat}\n`)
    } else if (filename === QUIRKYD_NODE_RUNTIME_MARKER_FILENAME) {
      mkdirSync(dirname(staged), { recursive: true })
      writeFileSync(staged, `${pinnedNodeRuntimeAsset(compat).executableSha256}\n`)
    } else {
      const source = slotFiles.get(filename) ?? join(basePackageDir, ...filename.split('/'))
      copy(source, staged, isExecutable(filename))
    }
    files[filename] = sha256(staged)
  }
  return { files }
}

/**
 * `--dark-test-template` lets a dark switch through for test servers only; the template then
 * carries the switch's marker, which packaging refuses.
 */
export function assertTemplateBuildAllowed(argv = process.argv, env = process.env) {
  if (!argv.includes('--dark-test-template')) {
    // The template is what releases ship as the server; a dark build must never become one.
    assertNotDarkBuild([], env)
  }
}

function sameBytes(left, right) {
  return sha256(left) === sha256(right)
}

async function main() {
  assertTemplateBuildAllowed()
  const templateTargets = requestedTemplateTargets()
  rmSync(buildDir, { recursive: true, force: true })
  const packages = Object.fromEntries(
    templateTargets.map((target) => [target, buildTargetPackage(target)])
  )
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })
  const [firstTarget] = templateTargets
  // Every package carries the same page: its manifest is a common file, checked byte for byte below.
  const commonArtifacts = quirkydTemplateCommonFilenames(
    readQuirkydMobileWebAssetFilenames(packages[firstTarget])
  )
  for (const filename of commonArtifacts) {
    const source = join(packages[firstTarget], ...filename.split('/'))
    // Why check every target: the template keeps one copy, so a per-target difference would ship wrong bytes.
    for (const target of templateTargets) {
      if (!sameBytes(source, join(packages[target], ...filename.split('/')))) {
        throw new Error(`${filename} differs between ${firstTarget} and ${target} packages`)
      }
    }
    copy(source, join(outputDir, ...filename.split('/')), isExecutable(filename))
  }
  const targets = Object.fromEntries(
    templateTargets.map((target) => [target, stageTarget(target, packages[target])])
  )
  // A partial CI template stages a compat target only beside its base target.
  for (const compat of COMPAT_SERVER_TARGETS.filter((candidate) =>
    templateTargets.includes(COMPAT_SERVER_TARGET_BASES[candidate])
  )) {
    const staged = stageCompatTarget(compat, packages[COMPAT_SERVER_TARGET_BASES[compat]])
    if (staged) {
      targets[compat] = staged
    }
  }
  const commonSha256 = Object.fromEntries(
    commonArtifacts.map((filename) => [filename, sha256(join(outputDir, filename))])
  )
  writeFileSync(
    join(outputDir, QUIRKYD_TEMPLATE_MANIFEST_FILENAME),
    `${JSON.stringify({ schemaVersion: 3, commonSha256, targets }, null, 2)}\n`
  )
  verifyPackagedQuirkydTemplate(join(root, 'out'), templateTargets)
  // Outside the manifest, so deploys never copy it; it marks the whole template as test-only.
  for (const marker of darkBuildMarkers()) {
    writeFileSync(join(outputDir, marker.fileName), marker.text)
  }
  rmSync(buildDir, { recursive: true, force: true })
  process.stdout.write(`[build-quirkyd-template] ok — ${Object.keys(targets).length} targets\n`)
}

if (process.argv[1]?.endsWith('build-quirkyd-template.mjs')) {
  await main()
}
