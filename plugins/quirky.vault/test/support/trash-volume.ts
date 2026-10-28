import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

const FOUNDATION_TRASH_SCRIPT = `ObjC.import('Foundation');
function run(argv) {
  const file = $.NSURL.fileURLWithPath($(argv[0]));
  const result = Ref();
  const error = Ref();
  const moved = $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(file, result, error);
  if (!ObjC.unwrap(moved)) {
    const detail = error[0] ? ObjC.unwrap(error[0].localizedDescription) : 'Foundation refused to move the item to Trash';
    throw new Error(detail);
  }
  return 'trashed';
}`

type HdiutilEntity = { 'dev-entry'?: unknown; 'mount-point'?: unknown }
type HdiutilAttachResult = { 'system-entities'?: HdiutilEntity[] }

function run(home: string, program: string, args: string[], input?: string): string {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    env: { ...process.env, QUIRKY_HOME: home },
    timeout: 30_000,
    killSignal: 'SIGKILL',
    ...(input === undefined ? {} : { input })
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`${basename(program)} ${args[0]} failed: ${details}`)
  }
  return result.stdout
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export class TrashVolume {
  readonly tmpDir: string
  readonly trashDirectory: string
  private readonly userTrashDirectory = join(homedir(), '.Trash')
  private mountedDevice: string | undefined
  private mounted = false
  private volumeDevice: number | undefined

  private constructor(
    private readonly rootDirectory: string,
    readonly mountPoint: string,
    userId: number
  ) {
    this.tmpDir = join(mountPoint, 'tmp')
    this.trashDirectory = join(mountPoint, '.Trashes', String(userId))
  }

  static create(): TrashVolume {
    if (process.platform !== 'darwin') throw new Error('Disposable macOS Trash volumes require macOS')
    const userId = process.getuid?.()
    if (userId === undefined) throw new Error('Disposable macOS Trash volumes require a POSIX user ID')

    const temporaryBase = realpathSync(tmpdir())
    const userTrash = existsSync(join(homedir(), '.Trash'))
      ? realpathSync(join(homedir(), '.Trash'))
      : resolve(homedir(), '.Trash')
    if (isWithin(userTrash, temporaryBase)) {
      throw new Error(`System temporary directory resolves inside the real user Trash: ${temporaryBase}`)
    }

    const rootDirectory = mkdtempSync(join(temporaryBase, 'qv-trash-volume-'))
    const mountPoint = join(rootDirectory, 'mount')
    const volume = new TrashVolume(rootDirectory, mountPoint, userId)

    try {
      mkdirSync(mountPoint)
      const imagePath = join(rootDirectory, 'trash.sparseimage')
      run(rootDirectory, '/usr/bin/hdiutil', [
        'create', '-quiet', '-size', '256m', '-fs', 'APFS', '-volname', `QuirkyVaultTrash-${randomUUID()}`,
        '-type', 'SPARSE', imagePath
      ])
      const attachOutput = run(rootDirectory, '/usr/bin/hdiutil', [
        'attach', '-plist', '-nobrowse', '-owners', 'off', '-mountpoint', mountPoint, imagePath
      ])
      volume.mounted = true
      const attachJson = run(rootDirectory, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], attachOutput)
      const entities = (JSON.parse(attachJson) as HdiutilAttachResult)['system-entities'] ?? []
      if (!entities.some((entity) => entity['mount-point'] === mountPoint)) {
        throw new Error('hdiutil did not mount the APFS image at its owned mount point')
      }
      const deviceEntry = entities.find((entity) => typeof entity['dev-entry'] === 'string')?.['dev-entry']
      if (typeof deviceEntry === 'string') volume.mountedDevice = deviceEntry

      const volumeStats = statSync(mountPoint)
      if (volumeStats.dev === statSync(rootDirectory).dev) {
        throw new Error('hdiutil mount point is still on the host temporary filesystem')
      }
      volume.volumeDevice = volumeStats.dev
      mkdirSync(volume.tmpDir, { mode: 0o700 })
      volume.createSafeTrashDirectory()
      volume.probeFoundationTrash()
      return volume
    } catch (error) {
      try {
        volume.cleanup()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Could not safely initialize or clean up the disposable Trash volume')
      }
      throw error
    }
  }

  assertSafeDeletionTarget(targetPath: string, sourceHome: string, quirkyHome: string): void {
    const volumeRoot = realpathSync(this.mountPoint)
    const sourceRoot = realpathSync(sourceHome)
    const home = realpathSync(quirkyHome)
    const targetInfo = lstatSync(targetPath)
    if (targetInfo.isSymbolicLink() || (!targetInfo.isFile() && !targetInfo.isDirectory())) {
      throw new Error(`Unsafe disposable-volume deletion target: ${targetPath}`)
    }

    const target = realpathSync(targetPath)
    for (const [label, path] of [['source home', sourceRoot], ['QUIRKY_HOME', home], ['delete target', target]] as const) {
      if (!isWithin(volumeRoot, path) || statSync(path).dev !== this.volumeDevice) {
        throw new Error(`${label} is not on the owned APFS Trash volume: ${path}`)
      }
    }
    if (!isWithin(sourceRoot, target) || target === sourceRoot || target === home) {
      throw new Error(`Delete target is outside its owned source home: ${target}`)
    }
    this.assertSafeTrashDestination()
  }

  listTrashEntries(): string[] {
    return readdirSync(this.trashDirectory).sort()
  }

  trashPathFor(name: string): string {
    if (basename(name) !== name || name === '.' || name === '..') throw new Error(`Invalid Trash entry name: ${name}`)
    return join(this.trashDirectory, name)
  }

  cleanup(): void {
    if (this.mounted || this.mountPointIsMounted()) {
      const failures: unknown[] = []
      const targets = [this.mountedDevice, this.mountPoint].filter((target): target is string => target !== undefined)
      let detached = false
      for (const target of targets) {
        try {
          run(this.rootDirectory, '/usr/bin/hdiutil', ['detach', '-force', target])
          detached = true
          break
        } catch (error) {
          failures.push(error)
        }
      }
      if (!detached) throw new AggregateError(failures, `Could not detach disposable APFS image mounted at ${this.mountPoint}`)
      this.mounted = false
      this.mountedDevice = undefined
    }
    rmSync(this.rootDirectory, { recursive: true, force: true })
  }

  private createSafeTrashDirectory(): void {
    const trashRoot = join(this.mountPoint, '.Trashes')
    this.ensureOwnedDirectory(trashRoot)
    this.ensureOwnedDirectory(this.trashDirectory)
    this.assertSafeTrashDestination()
  }

  private ensureOwnedDirectory(path: string): void {
    try {
      const current = lstatSync(path)
      if (current.isSymbolicLink() || !current.isDirectory()) throw new Error(`Unsafe Trash directory: ${path}`)
    } catch (error) {
      if (!isMissing(error)) throw error
      mkdirSync(path, { mode: 0o700 })
    }
    if (statSync(path).dev !== this.volumeDevice) throw new Error(`Trash directory is not on the owned volume: ${path}`)
    accessSync(path, constants.W_OK | constants.X_OK)
  }

  private assertSafeTrashDestination(): void {
    const volumeRoot = realpathSync(this.mountPoint)
    const trashRoot = realpathSync(this.trashDirectory)
    const userTrashRoot = this.userTrashDirectory
    if (!isWithin(volumeRoot, trashRoot) || statSync(trashRoot).dev !== this.volumeDevice) {
      throw new Error(`The OS Trash destination is not on the owned APFS volume: ${trashRoot}`)
    }
    if (isWithin(userTrashRoot, trashRoot) || isWithin(trashRoot, userTrashRoot)) {
      throw new Error('The disposable-volume Trash destination overlaps the real user Trash')
    }
  }

  private probeFoundationTrash(): void {
    const probeName = `.qv-trash-probe-${randomUUID()}`
    const probePath = join(this.mountPoint, probeName)
    writeFileSync(probePath, 'isolated Foundation Trash destination probe\n', { flag: 'wx', mode: 0o600 })
    try {
      run(this.rootDirectory, '/usr/bin/osascript', ['-l', 'JavaScript', '-e', FOUNDATION_TRASH_SCRIPT, probePath])
      if (existsSync(probePath)) throw new Error('Foundation reported success without moving the isolated Trash probe')
      const trashedProbe = this.trashPathFor(probeName)
      if (!existsSync(trashedProbe)) throw new Error('Foundation did not place its probe in the owned volume Trash')
      const resolvedProbe = realpathSync(trashedProbe)
      const volumeRoot = realpathSync(this.mountPoint)
      if (!isWithin(realpathSync(this.trashDirectory), resolvedProbe) || !isWithin(volumeRoot, resolvedProbe)) {
        throw new Error(`Foundation moved its probe outside the owned volume Trash: ${resolvedProbe}`)
      }
      if (statSync(resolvedProbe).dev !== this.volumeDevice) {
        throw new Error('Foundation moved its probe to a different filesystem')
      }
    } finally {
      if (existsSync(probePath)) unlinkSync(probePath)
    }
  }

  private mountPointIsMounted(): boolean {
    try {
      return statSync(this.mountPoint).dev !== statSync(this.rootDirectory).dev
    } catch {
      return false
    }
  }
}
