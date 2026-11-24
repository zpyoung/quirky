import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'
import { recordSkillDeleteOperation } from './skill-operation-observability'

type CapturingSink = TracerSink & { records: unknown[] }

let sink: CapturingSink

beforeEach(() => {
  sink = {
    records: [],
    push(record) {
      this.records.push(record)
    },
    flush() {},
    close() {}
  }
  setActiveSink(sink)
})

afterEach(() => {
  _resetTracerForTests()
})

describe('skill operation observability', () => {
  it('records delete batches as bounded counts and capped root ids', () => {
    recordSkillDeleteOperation({
      operationId: 'operation-private',
      hostKind: 'native-host',
      skills: [{ status: 'deleted' }, { status: 'deleted' }, { status: 'failed' }],
      rootIds: Array.from({ length: 20 }, (_, index) => `root-${index}`)
    })

    const serialized = JSON.stringify(sink.records)
    expect(serialized).toContain('skill.delete')
    expect(serialized).toContain('"deletedCount":2')
    expect(serialized).toContain('root-11')
    expect(serialized).not.toContain('root-12')
    expect(serialized).not.toContain('operation-private')
  })
})
