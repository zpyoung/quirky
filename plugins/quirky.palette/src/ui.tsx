import type { UiPluginContext } from '@quirky/protocol'

/** Provides the overridable shortcut action through the same public palette capability as other plugins. */
export function activate(context: UiPluginContext): void {
  context.provide('command:quirky.palette/toggle', () => context.setPalette())
}
