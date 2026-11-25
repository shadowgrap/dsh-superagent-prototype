/** Gitea Source configuration and the startup checks that name where an operator fixes an unusable instance. */
import { join } from 'node:path'
import { z } from 'zod'
import { executable, type Machine, type Probe } from './deployment.ts'
import { workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** The Gitea Source's settings: the account fields the GitHub Source takes, plus the instance URL and its polling. */
export const GiteaConfigSchema = z.object({
  baseUrl: z.string().trim().url(),
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observePulls: z.boolean().default(false),
  observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false),
}).strict()
export type GiteaConfig = z.infer<typeof GiteaConfigSchema>
/** A signed-in Gitea account and repository, ready for `gt` calls in one isolated config directory. */
export interface GiteaDeployment {
  cli: string; login: string; noreply: string; baseUrl: string; configDir: string; repository: string; version: string
}

const Instance = z.object({ version: z.string() })
const Account = z.object({ login: z.string().regex(/^[A-Za-z0-9_.-]+$/) })
const RepositoryAccess = z.object({
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  permissions: z.object({ push: z.boolean().nullable() }),
})
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  try { const result = schema.safeParse(JSON.parse(text)); return result.success ? result.data : undefined }
  catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
}
/** The major version of a `gt` or Gitea version string such as `gt version 2.0.0` or `28.4.0`. */
const major = (version: string): number => Number(/(\d+)\.(\d+)/.exec(version)?.[1] ?? 0)

/**
 * Verify the configured Gitea CLI, instance, account and repository: gt 2.0 or later, Gitea 28 or later, a signed-in account
 * whose token reads notifications, and a repository it can push to. Every check names the settings the operator fixes.
 */
export async function resolveDeploymentGitea(machine: Machine, gitea: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<GiteaDeployment> {
  const config = GiteaConfigSchema.parse(gitea ?? {})
  const { baseUrl, repository } = config
  if (!repository) throw new SetupError('giteaRepositoryUnset')
  if (!config.cli) throw new SetupError('giteaCliUnset')
  let cli: string
  try { cli = executable(config.cli, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('giteaCliMissing', { output: reason(error) }) }
  const configDir = join(machine.stateDir, 'gitea-cli')
  // The CLI reads nothing from the operator's own Gitea configuration: one directory per profile holds hosts and credentials.
  const env = ['env', `GITEA_CLI_CONFIG_DIR=${configDir}`, 'GITEA_CLI_ERROR_FORMAT=json']
  const run = (...args: string[]): Promise<string> => probe([...env, cli, '--host', baseUrl, '--no-input', ...args])
  const version = await probe([...env, cli, 'version']).catch((error: unknown) => { throw new SetupError('giteaCliMissing', { output: reason(error) }) })
  if (major(version) < 2) throw new SetupError('giteaCliTooOld', { version: version.trim() })
  const instance = parsed(Instance, await run('api', 'version').catch((error: unknown) => { throw new SetupError('giteaTooOld', { url: baseUrl, version: reason(error) }) }))
  if (!instance || major(instance.version) < 28) throw new SetupError('giteaTooOld', { url: baseUrl, version: instance?.version ?? 'unknown' })
  const account = parsed(Account, await run('api', 'user').catch((error: unknown) => {
    throw new SetupError('giteaNotLoggedIn', { configDir, url: baseUrl, output: reason(error) })
  }))
  if (!account) throw new SetupError('giteaNotLoggedIn', { configDir, url: baseUrl })
  const who = { login: account.login, repository, url: baseUrl }
  await run('notification', 'list', '--limit=1', '--json=id').catch((error: unknown) => {
    throw new SetupError('giteaNotificationsUnreadable', { ...who, output: reason(error) })
  })
  const access = parsed(RepositoryAccess, await run('api', `repos/${repository}`).catch((error: unknown) => {
    throw new SetupError('giteaRepositoryUnreadable', { ...who, output: reason(error) })
  }))
  if (!access) throw new SetupError('giteaRepositoryUnreadable', who)
  if (access.permissions.push !== true) throw new SetupError('giteaRepositoryReadOnly', who)
  const { hostname } = new URL(baseUrl)
  return { cli, login: account.login, noreply: `${account.login}@noreply.${hostname}`, baseUrl, configDir, repository: access.full_name, version: instance.version }
}
