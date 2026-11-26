/** Pairs each item with a position-derived key: lists from a validated spec or parsed block never reorder, so position is their only identity. */
export function positionKeyed<T>(items: readonly T[]): { key: string; item: T }[] {
  return items.map((item, position) => ({ key: `item-${position}`, item }))
}
