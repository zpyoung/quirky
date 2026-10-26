import { resolve } from 'node:path'
import { renderDistroInspection } from '../inspection'
import { formatTable } from '../output'
import { takePositionals } from './support'
import type { Command } from './types'

export const distroInspect: Command = {
  name: 'distro inspect',
  summary: 'list everything installing the distro at <path> would change; installs nothing',
  positionals: [{ name: 'path', description: 'the distro directory', required: true }],
  flags: {},
  methods: ['distro.inspect'],
  plugin: null,
  async run(args, ctx) {
    const [path] = takePositionals(args, ['path'])
    const inspection = await ctx.rpc.call('distro.inspect', { path: resolve(ctx.cwd, path) })
    ctx.out.result(inspection, () => renderDistroInspection(inspection))
  }
}

export const distroInstall: Command = {
  name: 'distro install',
  summary: 'install the distro at <path> after listing what it changes; confirms unless --yes',
  positionals: [{ name: 'path', description: 'the distro directory', required: true }],
  flags: {},
  methods: ['distro.inspect', 'distro.install'],
  plugin: null,
  async run(args, ctx) {
    const [path] = takePositionals(args, ['path'])
    const absolute = resolve(ctx.cwd, path)
    const inspection = await ctx.rpc.call('distro.inspect', { path: absolute })
    if (!ctx.out.json) ctx.out.line(`${renderDistroInspection(inspection)}\n\n`)
    const distro = await ctx.rpc.call('distro.install', { path: absolute })
    ctx.out.result(distro, () => `installed ${distro.id} ${distro.version}`)
  }
}

export const distroList: Command = {
  name: 'distro list',
  summary: 'list installed distros',
  positionals: [],
  flags: {},
  methods: ['distro.list'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const distros = await ctx.rpc.call('distro.list', {})
    ctx.out.result(distros, () =>
      distros.length
        ? formatTable(
            ['ID', 'NAME', 'VERSION', 'PLUGINS'],
            distros.map((distro) => [distro.id, distro.name, distro.version, distro.plugins.join(', ') || '-'])
          )
        : 'no distros'
    )
  }
}

export const distroRemove: Command = {
  name: 'distro remove',
  summary: 'remove an installed distro and its plugins; confirms unless --yes',
  positionals: [{ name: 'id', description: 'the distro to remove', required: true }],
  flags: {},
  methods: ['distro.remove'],
  plugin: null,
  async run(args, ctx) {
    const [id] = takePositionals(args, ['id'])
    const result = await ctx.rpc.call('distro.remove', { id })
    ctx.out.result(result, () => `removed ${id}`)
  }
}
