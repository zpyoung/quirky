export function getQuirkyCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'quirky-ide'
  }
  if (platform === 'win32') {
    return 'quirky.cmd'
  }
  return 'quirky'
}
