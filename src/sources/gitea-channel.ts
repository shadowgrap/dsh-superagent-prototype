/** Gitea outbound channel: comments a conversation or replies inside an inline review thread, under the deployment's account. */
import type { OutboundMessage } from '../core/index.ts'
import type { GiteaDeployment } from '../deployment-gitea.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { Gt } from '../infra/gt.ts'
import { sameName } from '../infra/text.ts'
import { conversationComments } from './gitea-read.ts'
import { giteaPage } from './gitea-trigger.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

type Host = { commands: Pick<Commands, 'deployment' | 'run'> }
/** Instance flags of every `gt` call, as `Gt` builds them. */
const instance = (gitea: GiteaDeployment): string[] => ['--host', gitea.baseUrl, '-R', gitea.repository, '--no-input']
const isolated = (gitea: GiteaDeployment): Record<string, string> =>
  ({ GITEA_CLI_CONFIG_DIR: gitea.configDir, GITEA_CLI_ERROR_FORMAT: 'json' })
/** A conversation that no longer exists: Gitea answers 404 for a deleted Issue and its comments. */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
/** The transport the Source's reads share; every call carries the deployment's isolated config directory, never the operator's. */
export function giteaTransport(commands: Pick<Commands, 'deployment' | 'run'>): Gt {
  const { gitea } = commands.deployment
  if (!gitea) throw new Error('The Gitea Source has no working account')
  return new Gt({ cli: gitea.cli, host: gitea.baseUrl, repository: gitea.repository, configDir: gitea.configDir },
    (program, args, env) => commands.run(program, args, undefined, env))
}
/**
 * Writes one message once: its body carries an HTML marker, so a retry finds the comment it already sent.
 * An inline reply goes through `gt pr review reply`, which answers the root comment the address names.
 */
export async function sendGitea(host: Host, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { gitea } = commands.deployment
  if (!gitea) throw new Error('The Gitea Source has no working account')
  const number = Number(message.channel.address.number)
  if (!number) throw new Error('Missing Gitea reply target')
  const body = `${message.text}\n\n<!-- dsh-superagent:${message.id} -->`
  const root = Number(message.channel.address.root ?? '')
  try {
    if (root) {
      // ponytail: an inline reply is not listed back, so a retry after a lost answer can repeat it; count the thread's comments if that happens.
      await commands.run(gitea.cli, [...instance(gitea), 'pr', 'review', 'reply', String(number), String(root), '-b', body], undefined, isolated(gitea))
      return 'sent'
    }
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const mine = (comment: { user: { login: string }; body?: string | null }): boolean =>
      sameName(comment.user.login, gitea.login) && (comment.body ?? '').includes(marker)
    if ((await conversationComments(giteaTransport(commands), number)).some(mine)) return 'sent'
    const pull = /\/pulls?\//i.test(message.channel.address.url ?? '')
    await commands.run(gitea.cli, [...instance(gitea), pull ? 'pr' : 'issue', 'comment', String(number), '-b', body], undefined, isolated(gitea))
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** Links an address to its page on the instance, naming an inline review comment as the discussion it belongs to. */
export function giteaLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  const review = !!address.root || /#issuecomment-/.test(address.url ?? '')
  const page = links.gitea ? giteaPage(links.gitea.baseUrl, links.gitea.repository, Number(number)) : ''
  return { url: address.url ?? page,
    label: review ? { zh: `Gitea #${number} 的 review 讨论`, en: `Review discussion on Gitea #${number}` }
      : { zh: `Gitea #${number}`, en: `Gitea #${number}` } }
}
