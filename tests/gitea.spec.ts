import { describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { CliError } from '../src/infra/commands.ts'
import { newRound, pollNotifications } from '../src/sources/gitea.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { testDeployment } from './fixtures/deployment.ts'

const gitea = { cli: '/usr/bin/gt', login: 'fiume_bot', noreply: 'fiume_bot@noreply.gitea.example.com',
  baseUrl: 'https://gitea.example.com', configDir: '/tmp/state/gitea-cli', repository: 'o/r', version: '28.4.0' }
const issue = { id: 7, number: 7, title: 'A bug', state: 'open', created_at: '2026-09-01T00:00:00Z',
  html_url: 'https://gitea.example.com/o/r/issues/7', body: 'it breaks', user: { login: 'alice' } }
const comment = { id: 5, body: '@fiume_bot take this', user: { login: 'alice' }, created_at: '2026-09-08T00:05:00Z',
  updated_at: '2026-09-08T00:05:00Z', html_url: 'https://gitea.example.com/o/r/issues/7#issuecomment-5' }
const notification = { id: 96357, number: 7, type: 'issue', state: 'open', unread: true, updated_at: '2026-09-08T00:05:00Z', title: 'A bug' }

/** A SourceContext over canned gt answers, keyed by the whole command line. */
function host(answer: (command: string) => unknown) {
  const state = new Map<string, unknown>()
  const calls: string[] = []
  const received: Trigger[] = []
  const meta = new Map<string, Record<string, unknown>>()
  const described = new Map<string, Record<string, unknown>>()
  const commands = {
    deployment: testDeployment({ repository: 'o/r', gitea }),
    withSignal: () => commands,
    run: async (_program: string, args: string[]) => {
      const command = args.join(' ')
      calls.push(command)
      const replied = answer(command)
      if (replied instanceof Error) throw replied
      return JSON.stringify(replied)
    },
  }
  const ctx = {
    deployment: commands.deployment,
    commands,
    config: () => ({ pollSeconds: 60 }),
    receive: async (trigger: Trigger) => { received.push(trigger); return { decisionId: 'd' } },
    atomic: <T>(work: () => T): T => work(),
    state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value) } },
    threads: {
      patch: (key: string, values: Record<string, unknown>) => { meta.set(key, { ...meta.get(key) ?? {}, ...values }) },
      describe: (key: string, description: Record<string, unknown>) => { described.set(key, description) },
    },
    report: () => undefined,
  } as unknown as SourceContext
  return { ctx, calls, received, state, threadMeta: (key: string) => meta.get(key) ?? {}, described: (key: string) => described.get(key) ?? {} }
}

describe('gitea notification round', () => {
  it('reads the Issue a notification names, two minutes before its cursor, and the comments since', async () => {
    const h = host(command => command.includes('notification list') ? [notification]
      : command.includes('/issues/7/comments') ? [comment] : issue)
    h.state.set('gitea-since', '2026-09-08T00:00:00.000Z')
    expect(await pollNotifications(h.ctx, newRound())).toBe(1)
    expect(h.received.map(trigger => trigger.meta)).toEqual([expect.objectContaining({ number: 7, kind: 'conversation', isPr: false })])
    expect(h.received[0]!.text).toBe('@fiume_bot take this')
    expect(h.calls.some(command => command.includes('--since=2026-09-07T23:58:00.000Z'))).toBe(true)
    expect(h.state.get('gitea-cursor:7')).toBeDefined()
    expect(h.threadMeta('gitea:7')).toMatchObject({ title: 'A bug' })
    expect(h.described('gitea:7')).toMatchObject({ label: '#7 A bug', facts: { number: { value: '#7' } } })
  })
  it('fails the round once for a read it could not finish, and retries it from the same point next round', async () => {
    const h = host(command => command.includes('notification list') ? [notification]
      : command.includes('/issues/7') ? new CliError('gh: Bad Gateway (HTTP 502)', 502) : { full_name: 'o/r' })
    h.state.set('gitea-since', '2026-09-08T00:00:00.000Z')
    const round = newRound()
    await pollNotifications(h.ctx, round)
    expect(round.failures).toEqual(['#7: Error: gh: Bad Gateway (HTTP 502)'])
    expect(h.state.get('gitea-retry')).toEqual({ 7: { since: '2026-09-08T00:00:00.000Z', pr: false, attempts: 1, failedAt: expect.any(String) } })
    expect(h.threadMeta('gitea:7').pollError).toContain('Bad Gateway')
  })
  it('drops an Issue the repository no longer has, without failing the round', async () => {
    const h = host(command => command.includes('notification list') ? [notification]
      : command.includes('/issues/7') ? new CliError('gh: Not Found (HTTP 404)', 404) : { full_name: 'o/r' })
    const round = newRound()
    await pollNotifications(h.ctx, round)
    expect(round.dropped).toEqual([7])
    expect(round.failures).toEqual([])
    expect(h.state.get('gitea-retry')).toEqual({})
  })
})
