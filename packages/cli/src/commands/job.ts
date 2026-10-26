import { formatDuration, type JobRun } from '@quirky/protocol'
import { formatTable } from '../output'
import { takePositionals } from './support'
import type { Command } from './types'

function isoOrDash(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toISOString()
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
  usage: 'job list',
  summary: 'list scheduled plugin jobs with their next and last run',
  flags: {},
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
  usage: 'job run <id>',
  summary: 'run a job now and wait for it; exits 1 unless it succeeds',
  flags: {},
  async run(args, ctx) {
    const [id] = takePositionals(args, ['id'])
    const result = await ctx.rpc.call('job.run', { id })
    ctx.out.result(result, () => {
      const elapsed = (result.finishedAt ?? result.startedAt) - result.startedAt
      return `${id} ${result.status} in ${elapsed} ms${result.error ? `: ${singleLine(result.error)}` : ''}`
    })
    if (result.status !== 'ok') throw new Error(`job ${id} ${result.status}`)
  }
}
