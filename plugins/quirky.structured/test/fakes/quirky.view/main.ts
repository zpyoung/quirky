export function activate(context: any) {
  const fakes = (globalThis as any).__chatFakes
  fakes.emitView = (event: 'changed' | 'rejected', data: unknown) => context.emit(event, data)
}
