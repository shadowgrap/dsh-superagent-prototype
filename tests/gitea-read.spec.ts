import { describe, expect, it } from 'vitest'
import { ciSnapshot } from '../src/sources/gitea-read.ts'

describe('gitea CI snapshot', () => {
  it('keeps the newest status of each context, as the github kind does', () => {
    const snapshot = ciSnapshot('abc', [
      { id: 1, context: 'test', status: 'success' },
      { id: 3, context: 'test', status: 'failure' },
      { id: 2, context: 'lint', status: 'pending' },
    ])
    expect(snapshot).toEqual({ head: 'abc', checks: [], statuses: [
      { context: 'lint', state: 'pending' }, { context: 'test', state: 'failure' }] })
  })
})
