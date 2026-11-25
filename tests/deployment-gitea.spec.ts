import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GiteaConfigSchema, resolveDeploymentGitea } from '../src/deployment-gitea.ts'
import { testMachine } from './fixtures/deployment.ts'

const machine = testMachine({ stateDir: '/tmp/state' })
const config = { baseUrl: 'https://gitea.example.com', repository: 'o/r', cli: process.execPath }
const answers: Record<string, string> = {
  version: 'gt version 2.0.0',
  'api version': '{"version":"28.4.0"}',
  'api user': '{"login":"fiume_bot","id":7}',
  'notification list': '[]',
  'api repos/o/r': JSON.stringify({ full_name: 'o/r', default_branch: 'main', permissions: { push: true } }),
}
/** A probe that answers the gt call whose arguments end with a known key, and records every call. */
function probes(over: Partial<Record<keyof typeof answers, string | Error>> = {}) {
  const calls: string[][] = []
  const probe = async (argv: string[]): Promise<string> => {
    calls.push(argv)
    const command = Object.keys(answers).filter(key => argv.slice(4).join(' ').includes(key)).sort((a, b) => b.length - a.length)[0]!
    const answer = over[command] ?? answers[command]!
    if (answer instanceof Error) throw answer
    return answer
  }
  return { calls, probe }
}
const code = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise } catch (error) { return (error as { code?: string }).code ?? 'no-code' }
  return 'resolved'
}

describe('Gitea configuration', () => {
  it('fills the polling and observation defaults, and refuses a key it does not know', () => {
    expect(GiteaConfigSchema.parse({ baseUrl: 'https://gitea.example.com', repository: 'o/r', cli: 'gt' })).toEqual({
      baseUrl: 'https://gitea.example.com', repository: 'o/r', cli: 'gt', pollSeconds: 60, failuresBeforeError: 3,
      observeIssues: false, observePulls: false, observeComments: false, observeCi: false })
    expect(GiteaConfigSchema.safeParse({ baseUrl: 'https://gitea.example.com', repository: 'o/r', cli: 'gt', credentialFile: 'x' }).success).toBe(false)
    expect(GiteaConfigSchema.safeParse({ baseUrl: 'https://gitea.example.com', repository: 'o/r', cli: 'gt', pollSeconds: 10 }).success).toBe(false)
  })
})

describe('Gitea deployment checks', () => {
  it('resolves the account, repository and instance version, through one isolated config directory', async () => {
    const { calls, probe } = probes()
    const deployment = await resolveDeploymentGitea(machine, config, probe)
    expect(deployment).toMatchObject({ login: 'fiume_bot', repository: 'o/r', baseUrl: config.baseUrl,
      configDir: join('/tmp/state', 'gitea-cli'), version: '28.4.0', noreply: 'fiume_bot@noreply.gitea.example.com' })
    expect(calls[0]!.slice(0, 3)).toEqual(['env', `GITEA_CLI_CONFIG_DIR=${join('/tmp/state', 'gitea-cli')}`, 'GITEA_CLI_ERROR_FORMAT=json'])
    expect(calls[0]).toContain('version')
    expect(calls.some(argv => argv.join(' ').includes('notification list'))).toBe(true)
  })
  it('names the place where a missing repository, a missing CLI or an old gt is fixed', async () => {
    expect(await code(resolveDeploymentGitea(machine, { ...config, repository: '' }, probes().probe))).toBe('giteaRepositoryUnset')
    expect(await code(resolveDeploymentGitea(machine, { ...config, cli: '' }, probes().probe))).toBe('giteaCliUnset')
    expect(await code(resolveDeploymentGitea(machine, { ...config, cli: 'no-such-gt-anywhere' }, probes().probe))).toBe('giteaCliMissing')
    expect(await code(resolveDeploymentGitea(machine, config, probes({ version: 'gt version 1.9.0' }).probe))).toBe('giteaCliTooOld')
    expect(await code(resolveDeploymentGitea(machine, config, probes({ 'api version': '{"version":"27.1.0"}' }).probe))).toBe('giteaTooOld')
  })
  it('names signing in, and the notification scope, as the fix for what the token cannot read', async () => {
    expect(await code(resolveDeploymentGitea(machine, config, probes({ 'api user': new Error('exit 4') }).probe))).toBe('giteaNotLoggedIn')
    expect(await code(resolveDeploymentGitea(machine, config, probes({ 'notification list': new Error('scope notification is required') }).probe))).toBe('giteaNotificationsUnreadable')
  })
  it('refuses a repository the account cannot read or cannot push to', async () => {
    expect(await code(resolveDeploymentGitea(machine, config, probes({ 'api repos/o/r': new Error('404') }).probe))).toBe('giteaRepositoryUnreadable')
    expect(await code(resolveDeploymentGitea(machine, config, probes({
      'api repos/o/r': JSON.stringify({ full_name: 'o/r', permissions: { push: false } }) }).probe))).toBe('giteaRepositoryReadOnly')
  })
})
