import { describe, expect, it } from 'vitest'
import { Gt } from '../src/infra/gt.ts'
import { ciSnapshot, conversationComments, readCi, readPath, readPull } from '../src/sources/gitea-read.ts'

const host = 'https://gitea.example.com'
const repository = 'o/r'
/** A Gt whose calls are answered by `answer` from the path inside the repository, as the API sees it. */
function fake(answer: (path: string, flags: string[]) => string) {
  const calls: string[][] = []
  const gt = new Gt({ cli: 'gt', host, repository, configDir: '/tmp/gt' }, async (_program, args) => {
    const at = args.findIndex(argument => argument.startsWith('repos/'))
    calls.push(args)
    return answer(at < 0 ? '' : args[at]!.slice(`repos/${repository}/`.length), args.slice(at + 1))
  })
  return { calls, gt }
}
const comment = (id: number) => ({ id, body: 'text', user: { login: 'someone' }, created_at: '2026-11-24T08:00:00Z' })

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
  it('reads a commit\'s statuses by every page of the API', async () => {
    const { calls, gt } = fake(() => JSON.stringify([{ id: 1, context: 'test', status: 'success' }, { id: 2, context: 'test', status: 'failure' }]))
    expect(await readCi(gt, 'abc123')).toEqual({ head: 'abc123', checks: [], statuses: [{ context: 'test', state: 'failure' }] })
    expect(calls[0]).toContain(`repos/${repository}/commits/abc123/statuses?limit=50&page=1`)
    expect(calls[0]).not.toContain('--paginate')
  })
  it('reads the statuses page by page, since the list carries no Link header to follow', async () => {
    const { calls, gt } = fake((_path, flags) => JSON.stringify(flags.includes('page=1') || calls.length === 1
      ? Array.from({ length: 50 }, (_, index) => ({ id: index + 1, context: 'test', status: 'success' }))
      : [{ id: 99, context: 'test', status: 'failure' }]))
    expect((await readCi(gt, 'abc')).statuses).toEqual([{ context: 'test', state: 'failure' }])
    expect(calls).toHaveLength(2)
  })
})

describe('gitea pull request read', () => {
  it('reads a pull request in the shape the github kind binds', async () => {
    const { calls, gt } = fake(path => path === 'pulls/7' ? JSON.stringify({
      title: 'a change', state: 'open', html_url: `${host}/${repository}/pulls/7`, user: { login: 'fiume_bot' },
      head: { sha: 'abc', ref: 'agent/x', repo: { full_name: repository } },
    }) : '{}')
    expect(await readPull(gt, 7)).toMatchObject({ number: 7, state: 'open', head: { sha: 'abc', ref: 'agent/x' } })
    expect(calls[0]).toContain(`repos/${repository}/pulls/7`)
  })
})

describe('gitea repository reads', () => {
  it('reads a file of the configured repository, encoding the segments of its path', async () => {
    const { calls, gt } = fake(() => 'line\n')
    expect(await readPath(gt, 'docs/some file.md')).toBe('line\n')
    expect(calls[0]).toContain(`repos/${repository}/raw/docs/some%20file.md`)
  })
  it('refuses a hidden path or one that leaves the repository', async () => {
    const { gt } = fake(() => '')
    for (const path of ['../secret', 'src/../../secret', '.env', 'src/.git/config', 'node_modules/x/index.js'])
      await expect(readPath(gt, path)).rejects.toThrow('Only non-hidden repository source paths are available')
  })
})

describe('gitea conversation comments', () => {
  it('reads one page when the page is short, skipping the items it cannot read', async () => {
    const { calls, gt } = fake(() => JSON.stringify([comment(1), { nonsense: true }, comment(2)]))
    const tally = { skipped: 0 }
    expect((await conversationComments(gt, 7, tally)).map(item => item.id)).toEqual([1, 2])
    expect(tally.skipped).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(`repos/${repository}/issues/7/comments?limit=50&page=1`)
  })
  it('reads the next page while a page is full, and stops at a short one', async () => {
    const { calls, gt } = fake((_path, flags) => JSON.stringify(flags.includes('page=1') || calls.length === 1
      ? Array.from({ length: 50 }, (_, index) => comment(index + 1)) : [comment(51)]))
    expect(await conversationComments(gt, 7)).toHaveLength(51)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain(`repos/${repository}/issues/7/comments?limit=50&page=2`)
  })
})

describe('gitea page cap', () => {
  it('fails a list longer than twenty pages rather than returning part of it', async () => {
    const { calls, gt } = fake(() => JSON.stringify(Array.from({ length: 50 }, (_, index) => comment(index + 1))))
    await expect(conversationComments(gt, 7)).rejects.toThrow('Gitea lists more than 1000 items for issues/7/comments')
    expect(calls).toHaveLength(20)
  })
})
