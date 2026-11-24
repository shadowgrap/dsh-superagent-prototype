import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Gt, type GtRun } from '../src/infra/gt.ts'

const connection = { cli: '/usr/bin/gt', host: 'https://git.example.org', repository: 'team/widgets', configDir: '/var/lib/dsh/gitea-cli' }
const flags = { GITEA_CLI_CONFIG_DIR: '/var/lib/dsh/gitea-cli', GITEA_CLI_ERROR_FORMAT: 'json' }
const instance = ['--host', 'https://git.example.org', '-R', 'team/widgets', '--no-input']

describe('gt transport', () => {
  it('asks gt for the configured instance and repository with an isolated config directory', async () => {
    const run = vi.fn<GtRun>(async () => '[]')
    await new Gt(connection, run).json(['notification', 'list'], ['id', 'number'], z.array(z.unknown()))
    expect(run).toHaveBeenCalledWith('/usr/bin/gt', [...instance, 'notification', 'list', '--json=id,number'], flags)
  })

  it('calls the API on a path inside the configured repository', async () => {
    const run = vi.fn<GtRun>(async () => '[]')
    expect(await new Gt(connection, run).api('commits/abc/statuses', '--paginate')).toBe('[]')
    expect(run).toHaveBeenCalledWith('/usr/bin/gt', [...instance, 'api', 'repos/team/widgets/commits/abc/statuses', '--paginate'], flags)
  })

  it('refuses an API path that leaves the configured repository', async () => {
    const run = vi.fn<GtRun>(async () => '[]')
    await expect(new Gt(connection, run).api('../../other/repo/issues')).rejects.toThrow('restricted to the configured repository')
    expect(run).not.toHaveBeenCalled()
  })

  it('reads every page of an API list', async () => {
    const run = vi.fn<GtRun>(async () => JSON.stringify([[{ context: 'a', status: 'success' }], [{ context: 'b', status: 'pending' }]]))
    const statuses = await new Gt(connection, run).pages(z.looseObject({ context: z.string(), status: z.string() }), 'commits/abc/statuses')
    expect(statuses).toEqual([{ context: 'a', status: 'success' }, { context: 'b', status: 'pending' }])
  })
})
