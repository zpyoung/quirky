import type { PluginContext } from '@quirky/protocol'

/**
 * Entry point of the Agents plugin, which owns the catalog of agent CLIs Quirky can launch:
 * their manifest data, detection on the machine, saved configuration, launch and resume plans,
 * workspace trust and first-prompt delivery. The pieces register themselves from here.
 */
export async function activate(context: PluginContext): Promise<void> {
  void context
}
