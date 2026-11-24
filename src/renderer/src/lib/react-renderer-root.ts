import { createRoot, type Root } from 'react-dom/client'

type RendererRootHotData = {
  quirkyRendererRoot?: Root
}

export function getOrCreateRendererRoot(
  container: HTMLElement,
  hotData?: RendererRootHotData
): Root {
  const existingRoot = hotData?.quirkyRendererRoot
  if (existingRoot) {
    return existingRoot
  }
  const root = createRoot(container)
  if (hotData) {
    hotData.quirkyRendererRoot = root
  }
  return root
}
