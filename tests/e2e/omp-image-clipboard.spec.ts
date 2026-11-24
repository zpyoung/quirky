import { writeFile } from 'node:fs/promises'
import { test, expect } from './helpers/quirky-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { showActivePaneAsNativeChat } from './helpers/native-chat-view'
import { waitForActiveTerminalManager } from './helpers/terminal'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAYUlEQVR4nO3PIREAIBAAMFqhMWgyUYMun4QQaBQZEO92twIrZ/RUde1URUBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgO9BiprrRUgkICAgICAgICAgICAgICAgICAgICAgIfHuebLmH1pKnMwAAAABJRU5ErkJggg=='

test('OMP composer accepts an image clipboard event', async ({
  quirkyPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(quirkyPage)
  await waitForActiveWorktree(quirkyPage)
  await ensureTerminalVisible(quirkyPage)
  await waitForActiveTerminalManager(quirkyPage)
  const imagePath = testInfo.outputPath('omp-image-proof.png')
  await writeFile(imagePath, Buffer.from(PNG, 'base64'))
  await showActivePaneAsNativeChat(quirkyPage, 'omp', 'OMP')
  const composer = quirkyPage.getByRole('textbox', {
    name: 'Ask anything, @ to mention files, / for commands',
    exact: true
  })
  await expect(composer).toBeVisible()
  // Substitute only clipboard persistence; never overwrite the user's system clipboard.
  await electronApp.evaluate(
    ({ ipcMain }, { imagePath }) => {
      ipcMain.removeHandler('clipboard:saveImageAsTempFile')
      ipcMain.handle('clipboard:saveImageAsTempFile', () => imagePath)
    },
    { imagePath }
  )
  await composer.evaluate((element, png) => {
    const data = new DataTransfer()
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
    data.items.add(new File([bytes], 'omp-image-proof.png', { type: 'image/png' }))
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
    )
  }, PNG)
  await expect(
    quirkyPage.getByRole('img', { name: 'omp-image-proof.png', exact: true })
  ).toBeVisible()
  await quirkyPage.screenshot({ path: testInfo.outputPath('omp-image-attached.png') })
})
