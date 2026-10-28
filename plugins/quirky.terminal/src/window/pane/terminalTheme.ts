/** `color` (#rgb or #rrggbb) with `alpha` applied as an rgba() string; any other format, or an alpha of 1, is returned as it was. */
export function withAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!hex) return color
  const digits = hex[1]!.length === 3 ? [...hex[1]!].map((digit) => digit + digit).join('') : hex[1]!
  const [red, green, blue] = [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16))
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, alpha)})`
}
