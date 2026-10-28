import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildMobilePages } from '../../mobile/scripts/build-pages'
import { bundlePlugins } from './bundle-plugins'

export async function bundleMobilePlugins(repositoryRoot: string, outputPluginsDirectory: string): Promise<string[] | null> {
  const sourcePluginsDirectory = join(repositoryRoot, 'plugins')
  if (!existsSync(sourcePluginsDirectory)) {
    rmSync(outputPluginsDirectory, { recursive: true, force: true })
    return null
  }
  if (!existsSync(join(sourcePluginsDirectory, 'quirky.mobile', 'quirky-plugin.json'))) {
    throw new Error('plugin quirky.mobile is required for the mobile page bundle')
  }
  await buildMobilePages(repositoryRoot)
  return bundlePlugins(sourcePluginsDirectory, outputPluginsDirectory)
}
