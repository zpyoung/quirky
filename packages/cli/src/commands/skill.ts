import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ParsedArgs } from '../args'
import { renderSkill } from '../skill'
import { loadCatalog } from './api'
import { requireFlag, takePositionals } from './support'
import type { Command, Context } from './types'

type SkillStatus = 'missing' | 'stale' | 'up-to-date'

const DIR_FLAG = { type: 'string', description: 'the skills folder; the skill goes in <dir>/quirky/SKILL.md', required: true } as const

function installed(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Replaces `path` with `text` through an exclusively created temp file beside it, which is removed on failure. */
function writeAtomically(path: string, text: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, text, { flag: 'wx', mode: 0o644 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

async function inspect(args: ParsedArgs, ctx: Context) {
  takePositionals(args, [])
  const path = join(resolve(ctx.cwd, requireFlag(args, 'dir')), 'quirky', 'SKILL.md')
  const text = renderSkill(await loadCatalog(ctx))
  const current = installed(path)
  const status: SkillStatus = current === null ? 'missing' : current === text ? 'up-to-date' : 'stale'
  return { path, text, status }
}

export const skillShow: Command = {
  name: 'skill show',
  summary: 'print the agent skill generated from the live catalog',
  positionals: [],
  flags: {},
  methods: ['api.describe'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const text = renderSkill(await loadCatalog(ctx))
    ctx.out.result({ skill: text }, () => text)
  }
}

export const skillInstall: Command = {
  name: 'skill install',
  summary: 'write the agent skill to <dir>/quirky/SKILL.md',
  positionals: [],
  flags: { dir: DIR_FLAG },
  methods: ['api.describe'],
  plugin: null,
  async run(args, ctx) {
    const { path, text, status } = await inspect(args, ctx)
    if (status !== 'up-to-date') {
      mkdirSync(dirname(path), { recursive: true })
      writeAtomically(path, text)
    }
    const result = status === 'up-to-date' ? status : 'installed'
    ctx.out.result({ status: result, path }, () => result)
  }
}

export const skillStatus: Command = {
  name: 'skill status',
  summary: 'report whether <dir>/quirky/SKILL.md is missing, stale or up-to-date',
  positionals: [],
  flags: { dir: DIR_FLAG },
  methods: ['api.describe'],
  plugin: null,
  async run(args, ctx) {
    const { path, status } = await inspect(args, ctx)
    ctx.out.result({ status, path }, () => status)
  }
}
