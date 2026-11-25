import { describe, expect, it } from 'vitest'
import { CliError } from '../src/infra/commands.ts'
import { giteaLink, sendGitea } from '../src/sources/gitea-channel.ts'
import { testDeployment } from './fixtures/deployment.ts'

const gitea = { cli: '/usr/bin/gt', login: 'fiume_bot', noreply: 'fiume_bot@noreply.gitea.example.com',
  baseUrl: 'https://gitea.example.com', configDir: '/tmp/state/gitea-cli', repository: 'o/r', version: '28.4.0' }
/** A Commands stand-in whose calls are answered by `answer` from the whole argv. */
function fake(answer: (argv: string[]) => string | Error) {
  const calls: { argv: string[]; env?: Record<string, string> }[] = []
  const commands = {
    deployment: testDeployment({ repository: 'o/r', gitea }),
    run: async (program: string, args: string[], _cwd?: string, env?: Record<string, string>) => {
      calls.push({ argv: [program, ...args], env })
      const replied = answer([program, ...args])
      if (replied instanceof Error) throw replied
      return replied
    },
  }
  return { calls, host: { commands } }
}
const message = (address: Record<string, string> = { number: '7' }) =>
  ({ id: 'm1', channel: { source: 'gitea', thread: 'gitea:7', address }, text: 'hello', kind: 'reply' as const })
const sent = (calls: { argv: string[] }[]) => calls.at(-1)!.argv.join(' ')

describe('gitea replies', () => {
  it('comments the conversation once, with the marker that makes a retry find it', async () => {
    const { calls, host } = fake(() => '[]')
    expect(await sendGitea(host, message())).toBe('sent')
    expect(calls[0]!.argv.join(' ')).toContain('api repos/o/r/issues/7/comments')
    expect(sent(calls)).toContain('issue comment 7 -b')
    expect(sent(calls)).toContain('<!-- dsh-superagent:m1 -->')
    expect(calls.at(-1)!.env).toMatchObject({ GITEA_CLI_CONFIG_DIR: '/tmp/state/gitea-cli' })
  })
  it('uses the pull request command when the address names a pull request', async () => {
    const { calls, host } = fake(() => '[]')
    await sendGitea(host, message({ number: '7', url: 'https://gitea.example.com/o/r/pulls/7#issuecomment-11' }))
    expect(sent(calls)).toContain('pr comment 7 -b')
  })
  it('replies inside the inline thread at the root comment the address names', async () => {
    const { calls, host } = fake(() => '[]')
    await sendGitea(host, message({ number: '7', root: '31' }))
    expect(sent(calls)).toContain('pr review reply 7 31 -b')
  })
  it('sends nothing when a comment of the agent already carries the marker', async () => {
    const { calls, host } = fake(() => JSON.stringify([{ id: 5, body: 'hello\n\n<!-- dsh-superagent:m1 -->', user: { login: 'fiume_bot' } }]))
    expect(await sendGitea(host, message())).toBe('sent')
    expect(calls).toHaveLength(1)
  })
  it('reports a deleted conversation as gone rather than failing the retry', async () => {
    const { host } = fake(() => '[]')
    const dead = { ...host, commands: { ...host.commands,
      run: async (_program: string, args: string[]) => {
        if (args.join(' ').includes('comment')) throw new CliError('no such issue', 404)
        return '[]'
      } } }
    expect(await sendGitea(dead, message())).toBe('gone')
  })
})

describe('gitea links', () => {
  it('links the conversation, and names an inline thread as one', () => {
    expect(giteaLink({ number: '7' }, { gitea })).toMatchObject({ url: 'https://gitea.example.com/o/r/issues/7' })
    expect(giteaLink({ number: '7', url: 'https://gitea.example.com/o/r/pulls/7#issuecomment-11' }, { gitea }).label.en)
      .toBe('Review discussion on Gitea #7')
    expect(giteaLink({ number: '7' }, {})).toMatchObject({ url: '' })
  })
})
