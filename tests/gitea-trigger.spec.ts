import { describe, expect, it } from 'vitest'
import {
  branchCiTrigger, ciTrigger, commentTrigger, giteaAddress, giteaPage, inlineRoot, isHumanLogin, issueTrigger, pullTrigger,
} from '../src/sources/gitea-trigger.ts'

const BOTS = ['fiume_bot', 'ci-bot']
const BASE = 'https://gitea.wochacha.cn'
const REPOSITORY = 'fiume_cui/dsh_superagent_test'
const comment = (over: Record<string, unknown> = {}) => ({
  id: 11, body: 'looks good', user: { login: 'someone' }, created_at: '2026-11-24T08:00:00Z',
  updated_at: '2026-11-24T08:00:00Z', html_url: `${BASE}/${REPOSITORY}/issues/7#issuecomment-11`, ...over,
})

describe('addresses', () => {
  it('builds the page of an Issue or a pull request on the instance, and reads either back', () => {
    expect(giteaPage(BASE, REPOSITORY, 7)).toBe(`${BASE}/${REPOSITORY}/issues/7`)
    expect(giteaPage(BASE, REPOSITORY, 7, true)).toBe(`${BASE}/${REPOSITORY}/pulls/7`)
    expect(giteaPage(`${BASE}/`, REPOSITORY, 7)).toBe(`${BASE}/${REPOSITORY}/issues/7`)
    expect(giteaAddress(`${BASE}/${REPOSITORY}/issues/7`, BASE, REPOSITORY)).toEqual({ number: 7, pr: false })
    expect(giteaAddress(`${BASE}/${REPOSITORY}/pulls/7#issuecomment-11`, BASE, REPOSITORY)).toEqual({ number: 7, pr: true })
    expect(giteaAddress(`${BASE}/api/v1/repos/${REPOSITORY}/issues/7`, BASE, REPOSITORY)).toEqual({ number: 7, pr: false })
  })
  it('ignores an address on another instance or in another repository', () => {
    expect(giteaAddress('https://gitea.example.com/fiume_cui/dsh_superagent_test/issues/7', BASE, REPOSITORY)).toBeUndefined()
    expect(giteaAddress(`${BASE}/someone/other/issues/7`, BASE, REPOSITORY)).toBeUndefined()
    expect(giteaAddress(`${BASE}/${REPOSITORY}/wiki/7`, BASE, REPOSITORY)).toBeUndefined()
  })
})

describe('people and bots', () => {
  it('takes only the Policy\'s automated accounts for a bot, whatever the account type says', () => {
    expect(isHumanLogin('someone', BOTS)).toBe(true)
    expect(isHumanLogin('fiume_bot', BOTS)).toBe(false)
    expect(isHumanLogin('FIUME_BOT', BOTS)).toBe(false)
  })
})

describe('conversation comments', () => {
  it('reaches the thread of the number the notification names, with its version as the ID', () => {
    const one = commentTrigger(comment(), { number: 7, isPr: false }, 'conversation', 'fiume_bot', BOTS)
    const later = commentTrigger(comment({ updated_at: '2026-11-24T09:00:00Z' }), { number: 7, isPr: false }, 'conversation', 'fiume_bot', BOTS)
    expect(one.threads).toEqual([{ source: 'gitea', id: '7' }])
    expect(one.channel).toEqual({ source: 'gitea', thread: 'gitea:7', address: { number: '7', url: comment().html_url } })
    expect(one.meta).toMatchObject({ number: 7, isPr: false, commentId: 11, kind: 'conversation' })
    expect(one.human).toBe(true)
    expect(one.id).not.toBe(later.id)
    expect(one.at).toBe('2026-11-24T08:00:00Z')
  })
  it('marks an addressed mention, and takes the agent\'s own comment for no person', () => {
    expect(commentTrigger(comment({ body: '@fiume_bot please look' }), { number: 7, isPr: false }, 'conversation', 'fiume_bot', BOTS).addressed).toBe('mention')
    expect(commentTrigger(comment({ user: { login: 'fiume_bot' } }), { number: 7, isPr: false }, 'conversation', 'fiume_bot', BOTS).human).toBe(false)
  })
})

describe('reviews', () => {
  const review = (over: Record<string, unknown> = {}) => comment({ id: 21, state: 'APPROVED', commit_id: 'abc123', submitted_at: '2026-11-24T10:00:00Z', path: undefined, ...over })
  it('folds the verdict into the text, at the commit it judged, versioned by its submission', () => {
    const one = commentTrigger(review(), { number: 7, isPr: true }, 'review', 'fiume_bot', BOTS)
    const again = commentTrigger(review({ submitted_at: '2026-11-24T11:00:00Z' }), { number: 7, isPr: true }, 'review', 'fiume_bot', BOTS)
    expect(one.text).toBe('APPROVED review of commit abc123\n\nlooks good')
    expect(one.id).not.toBe(again.id)
  })
  it('adds no verdict for a plain COMMENT review', () => {
    expect(commentTrigger(review({ state: 'COMMENT' }), { number: 7, isPr: true }, 'review', 'fiume_bot', BOTS).text).toBe('looks good')
    expect(commentTrigger(review({ state: 'PENDING' }), { number: 7, isPr: true }, 'review', 'fiume_bot', BOTS).text).toBe('looks good')
  })
})

describe('inline review comments', () => {
  const inline = (over: Record<string, unknown> = {}) =>
    comment({ id: 31, path: 'src/app.ts', line: 12, created_at: '2026-11-24T12:00:00Z', updated_at: null, diff_hunk: '@@ -1 +1 @@\n-a\n+b', ...over })
  it('names its file and line, and the earliest comment on that line as the root to reply to', () => {
    const thread = [inline({ id: 31 }), inline({ id: 32, created_at: '2026-11-24T12:30:00Z' }), inline({ id: 33, path: 'src/other.ts' })]
    expect(inlineRoot(thread[1]!, thread)!.id).toBe(31)
    expect(inlineRoot(thread[2]!, thread)!.id).toBe(33)
    const one = commentTrigger(thread[1]!, { number: 7, isPr: true }, 'inline', 'fiume_bot', BOTS, 31)
    expect(one.text).toBe('src/app.ts:12\n@@ -1 +1 @@\n-a\n+b\n\nlooks good')
    expect(one.meta).toMatchObject({ path: 'src/app.ts', line: 12, inlineRoot: 31 })
    expect(one.at).toBe('2026-11-24T12:30:00Z')
  })
})

describe('opened issues, pull requests and CI', () => {
  const opened = { number: 9, title: 'a bug', body: 'it breaks', user: { login: 'someone' }, created_at: '2026-11-24T07:00:00Z', html_url: `${BASE}/${REPOSITORY}/issues/9` }
  it('keeps one ID format for an Issue and the pull request it becomes', () => {
    expect(issueTrigger(opened, 'fiume_bot', BOTS).id).toBe(pullTrigger(opened, 'fiume_bot', BOTS).id)
    expect(pullTrigger(opened, 'fiume_bot', BOTS).meta).toMatchObject({ number: 9, isPr: true, prAuthor: 'someone' })
  })
  it('gives CI a version per revision, and no channel on the default branch', () => {
    const pull = ciTrigger({ number: 7, html_url: `${BASE}/${REPOSITORY}/pulls/7`, user: { login: 'someone' } }, 2, 'CI passed')
    expect(pull.meta).toMatchObject({ ci: true, revision: 2 })
    expect(pull.channel).toMatchObject({ thread: 'gitea:7' })
    expect(pull.id).not.toBe(ciTrigger({ number: 7, html_url: '', user: { login: 'a' } }, 3, 'CI passed').id)
    const branch = branchCiTrigger('main', 'abc', 1, 'CI passed', 'https://gitea.wochacha.cn/x/y/actions')
    expect(branch.threads).toEqual([{ source: 'gitea', id: 'ci:main' }])
    expect(branch.channel).toBeUndefined()
    expect(branch.human).toBe(false)
  })
})
