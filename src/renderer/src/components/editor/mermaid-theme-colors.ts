import type { MermaidThemeColors } from './mermaid-config'

export function readMermaidThemeColors(): MermaidThemeColors | undefined {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  if (!context) {
    return undefined
  }
  const styles = getComputedStyle(document.documentElement)
  const readColor = (token: string): string => {
    // Mermaid needs hex colors; tokens can resolve to color-mix() or oklch().
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = styles.getPropertyValue(token).trim()
    context.fillRect(0, 0, 1, 1)
    const pixel = context.getImageData(0, 0, 1, 1).data
    return `#${Array.from(pixel.slice(0, 3), (channel) => channel.toString(16).padStart(2, '0')).join('')}`
  }
  return {
    background: readColor('--background'),
    foreground: readColor('--foreground'),
    primary: readColor('--secondary'),
    secondary: readColor('--code-background'),
    tertiary: readColor('--card'),
    line: readColor('--muted-foreground'),
    pie: [
      readColor('--chart-1'),
      readColor('--chart-2'),
      readColor('--chart-3'),
      readColor('--chart-4'),
      readColor('--chart-5'),
      readColor('--chart-6'),
      readColor('--chart-7'),
      readColor('--chart-8')
    ]
  }
}
