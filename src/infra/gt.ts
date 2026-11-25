/** Gitea CLI transport: every call runs gt against one instance, repository and isolated config directory. */
import { z } from 'zod'
import { validItems, type Tally } from './commands.ts'

export interface GiteaConnection { cli: string; host: string; repository: string; configDir: string }
export type GtRun = (program: string, args: string[], env: Record<string, string>) => Promise<string>
/** A path that would leave the configured repository. */
const outside = (path: string): boolean => /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)

/** Reads one Gitea repository through the `gt` CLI, as `Commands` does for GitHub through `gh`. */
export class Gt {
  constructor(private readonly connection: GiteaConnection, private readonly run: GtRun) {}

  private call(command: string[]): Promise<string> {
    const { cli, host, repository, configDir } = this.connection
    return this.run(cli, ['--host', host, '-R', repository, '--no-input', ...command],
      { GITEA_CLI_CONFIG_DIR: configDir, GITEA_CLI_ERROR_FORMAT: 'json' })
  }

  /** Runs a gt command with the instance flags and returns its JSON output parsed against `schema`. */
  async json<T>(command: string[], fields: string[], schema: z.ZodType<T>): Promise<T> {
    return schema.parse(JSON.parse(await this.call([...command, `--json=${fields.join(',')}`])))
  }

  /** Calls the Gitea API on a path inside the configured repository, as `gh api` does for GitHub. */
  async api(path: string, ...flags: string[]): Promise<string> {
    if (outside(path)) throw new Error('Gitea calls are restricted to the configured repository')
    const { repository } = this.connection
    return this.call(['api', `repos/${repository}${path ? `/${path}` : ''}`, ...flags])
  }

  /** Reads an API path inside the configured repository and parses its JSON against `schema`. */
  async apiJson<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T> {
    return schema.parse(JSON.parse(await this.api(path, ...flags)))
  }

  /** Reads every page of an API list, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(JSON.parse(await this.api(path, '--paginate', '--slurp')))
    return validItems(item, pages.flat(), tally)
  }
}
