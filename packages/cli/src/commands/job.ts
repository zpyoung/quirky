import { formatDuration, type JobRun } from '@quirky/protocol'
import { CommandFailed, takePositionals } from '../args'
import { formatTable } from '../output'
import type { Command } from './types'

const pad = (value: number, width = 2) => String(Math.abs(value)).padStart(width, '0')

/** Local ISO 8601 time with the UTC offset, e.g. 2023-11-14T14:13:20-08:00. */
function localIso(ms: number): string {
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const year = date.getFullYear()
  const yearText = year < 0 || year > 9999 ? `${year < 0 ? '-' : '+'}${pad(year, 6)}` : pad(year, 4)
  return (
    `${yearText}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  )
}

function isoOrDash(ms: number | null): string {
  return ms === null ? '-' : localIso(ms)
}

function lastRun(run: JobRun | null): string {
  if (!run) return '-'
  const finished = run.finishedAt === null ? '' : ` ${isoOrDash(run.finishedAt)}`
  return `${run.status}${finished}${run.error ? `: ${run.error}` : ''}`
}

/** Keeps a cell on one line so an embedded line break can't split a table row. */
function singleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\\n')
}

export const jobList: Command = {
  name: 'job list',
  summary: 'list scheduled plugin jobs with their next and last run',
  positionals: [],
  flags: {},
  methods: ['job.list'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const jobs = await ctx.rpc.call('job.list', {})
    ctx.out.result(jobs, () =>
      jobs.length
        ? formatTable(
            ['ID', 'PLUGIN', 'INTERVAL', 'STATE', 'NEXT', 'LAST'],
            jobs.map((job) =>
              [job.id, job.plugin, formatDuration(job.intervalMs), job.state, isoOrDash(job.nextRunAt), lastRun(job.lastRun)].map(
                singleLine
              )
            )
          )
        : 'no jobs'
    )
  }
}

export const jobRun: Command = {
  name: 'job run',
  summary: 'run a job now and wait for it; exits 1 unless it succeeds',
  positionals: [{ name: 'id', description: 'the job ID', required: true }],
  flags: {},
  methods: ['job.run'],
  plugin: null,
  async run(args, ctx) {
    const [id] = takePositionals(args, ['id'])
    const result = await ctx.rpc.call('job.run', { id })
    ctx.out.result(result, () => {
      const elapsed = (result.finishedAt ?? result.startedAt) - result.startedAt
      return `${id} ${result.status} in ${elapsed} ms${result.error ? `: ${singleLine(result.error)}` : ''}`
    })
    if (result.status !== 'ok') throw new CommandFailed(`job ${id} ${result.status}`)
  }
}
