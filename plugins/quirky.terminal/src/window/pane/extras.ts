import type { ITerminalAddon, Terminal } from '@xterm/xterm'
import type { PaneSettings } from './settings'

/** Visible panes own these addons; a late module load cannot revive an unmounted or disabled renderer. */
export function createPaneExtras(terminal: Terminal, onError: (title: string, error: unknown) => void) {
  let disposed = false
  let image: ITerminalAddon | null = null
  let ligatures: ITerminalAddon | null = null
  let imageGeneration = 0
  let ligatureGeneration = 0
  let imagesWanted = false
  let ligaturesWanted = false

  return {
    sync(settings: PaneSettings) {
      const loading: Promise<void>[] = []
      const wantImages = settings['inline-images']
      if (wantImages !== imagesWanted) {
        imagesWanted = wantImages
        const generation = ++imageGeneration
        image?.dispose()
        image = null
        if (wantImages) {
          const pending = import('@xterm/addon-image').then(({ ImageAddon }) => {
            if (disposed || generation !== imageGeneration) return
            const addon = new ImageAddon({
              storageLimit: 8,
              pixelLimit: 1024 * 1024,
              sixelSizeLimit: 4 * 1024 * 1024,
              iipSizeLimit: 4 * 1024 * 1024,
              enableSizeReports: false
            })
            try {
              terminal.loadAddon(addon)
              image = addon
            } catch (error) {
              addon.dispose()
              throw error
            }
          }).catch((error: unknown) => {
            if (!disposed && generation === imageGeneration) onError('Could not enable inline images', error)
          })
          loading.push(pending)
        }
      }

      const mode = settings.ligatures
      const wantLigatures = mode === 'on' || (mode === 'auto' && /(?:fira|iosevka|jetbrains|cascadia|monaspace|hasklig)/i.test(settings['font-family']))
      if (wantLigatures !== ligaturesWanted) {
        ligaturesWanted = wantLigatures
        const generation = ++ligatureGeneration
        ligatures?.dispose()
        ligatures = null
        if (wantLigatures) {
          const pending = import('@xterm/addon-ligatures').then(({ LigaturesAddon }) => {
            if (disposed || generation !== ligatureGeneration) return
            const addon = new LigaturesAddon()
            try {
              terminal.loadAddon(addon)
              ligatures = addon
            } catch (error) {
              addon.dispose()
              throw error
            }
          }).catch((error: unknown) => {
            if (!disposed && generation === ligatureGeneration) onError('Could not enable font ligatures', error)
          })
          loading.push(pending)
        }
      }
      return Promise.all(loading).then(() => undefined)
    },
    dispose() {
      disposed = true
      imageGeneration++
      ligatureGeneration++
      image?.dispose()
      ligatures?.dispose()
      image = null
      ligatures = null
    }
  }
}
