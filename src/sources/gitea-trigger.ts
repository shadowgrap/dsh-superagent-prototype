/** Normalizes Gitea issues, pull requests, comments, reviews, and CI transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { mentions, reviewPlace } from './github-trigger.ts'

export const SOURCE = 'gitea'
/** Gitea reply address: the Issue or pull request conversation of `number`. */
export const giteaChannel = (number: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${number}`, address: { number: String(number), ...(url ? { url } : {}) } })
/** The web page of an Issue or pull request of `repository` on the instance `baseUrl` names, which may carry a subpath. */
export const giteaPage = (baseUrl: string, repository: string, number: number, pr = false): string =>
  `${baseUrl.replace(/\/+$/, '')}/${repository}/${pr ? 'pulls' : 'issues'}/${number}`
/** Parses a web or API URL for an Issue or pull request in `repository` on `baseUrl`; returns undefined for other instances, repositories, or pages. */
export function giteaAddress(url: string, baseUrl: string, repository: string): { number: number; pr: boolean } | undefined {
  const prefix = `${baseUrl.replace(/\/+$/, '')}/`
  if (!url.toLowerCase().startsWith(prefix.toLowerCase())) return undefined
  const match = /^(?:api\/v1\/repos\/)?([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?$/i.exec(url.slice(prefix.length).split('#')[0]!)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { number: Number(match[3]), pr: match[2]!.toLowerCase() !== 'issues' }
}
/**
 * True when the Policy does not list `login` among the instance's automated accounts.
 * Gitea marks no account as a bot, so the account list is the only evidence.
 */
export const isHumanLogin = (login: string, bots: readonly string[]): boolean => !bots.some(bot => sameName(bot, login))
/** Gitea returns a deleted account as `null` and displays it as `ghost`, as GitHub does. */
export const UserSchema = z.looseObject({ login: z.string() }).nullable()
  .transform(user => user ?? { login: 'ghost' })
/**
 * A Gitea comment or review; a review carries `state` and `commit_id` instead of `updated_at`, and an inline comment carries
 * its file, line, and diff hunk but no pointer to the comment it answers.
 */
export const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), submitted_at: z.string().nullish(),
  state: z.string().nullish(), commit_id: z.string().nullish(),
  path: z.string().nullish(), line: z.number().nullish(), original_line: z.number().nullish(), diff_hunk: z.string().nullish(),
})
export type GiteaComment = z.infer<typeof CommentSchema>
/** An Issue as `issues/<number>` returns it; Gitea tells a pull request apart by `pull_request`, which the caller passes on. */
export const IssueSchema = CommentSchema.extend({
  number: z.number(), title: z.string(), state: z.string(), created_at: z.string(), html_url: z.string(),
})
export type GiteaIssue = z.infer<typeof IssueSchema>
type Opened = Pick<GiteaIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>
export interface PullRef { number: number; isPr: boolean; url?: string; prAuthor?: string }
const author = (user: { login: string }, agent: string, bots: readonly string[]) =>
  ({ actor: { source: SOURCE, id: user.login }, human: isHumanLogin(user.login, bots) && !sameName(user.login, agent) })
/** The comment an inline reply answers: the earliest one on the same file and line, which Gitea does not point to. */
export function inlineRoot(comment: GiteaComment, thread: readonly GiteaComment[]): GiteaComment | undefined {
  const line = comment.line ?? comment.original_line ?? null
  return thread.filter(other => other.path === comment.path && (other.line ?? other.original_line ?? null) === line)
    .reduce<GiteaComment | undefined>((earliest, other) =>
      !earliest || (other.created_at ?? '') < (earliest.created_at ?? '') ? other : earliest, undefined)
}
/** A review states its verdict in `state`, which a plain `COMMENT` or `PENDING` review does not. */
const verdict = (comment: GiteaComment): string =>
  comment.state && comment.state !== 'COMMENT' && comment.state !== 'PENDING'
    ? `${comment.state} review of commit ${comment.commit_id ?? 'unknown'}`
    : ''
function commentText(comment: GiteaComment, kind: 'conversation' | 'inline' | 'review'): string {
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [kind === 'review' ? verdict(comment) : '', place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
/**
 * Builds a trigger for a comment or review. A review is versioned by its submission and an inline comment by its creation,
 * since neither moves its `updated_at`; an inline comment carries `inlineRootId`, the comment a reply answers.
 */
export function commentTrigger(comment: GiteaComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string,
  bots: readonly string[], inlineRootId?: number): Trigger {
  const at = (kind === 'review' ? comment.submitted_at : kind === 'inline' ? comment.created_at
    : comment.updated_at ?? comment.created_at) ?? new Date().toISOString()
  const id = key('gitea-comment', comment.html_url ?? `gitea:${ref.number}`, String(comment.id), at)
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: String(ref.number) }], ...author(comment.user, agent, bots), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: giteaChannel(ref.number, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { number: ref.number, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...inlineRootId !== undefined ? { inlineRoot: inlineRootId } : {} } }
}
/** Builds the trigger for a newly opened Issue's title and body. */
export function issueTrigger(issue: Opened, agent: string, bots: readonly string[]): Trigger {
  const body = issue.body ?? ''
  return { id: key('gitea-issue', String(issue.number)), source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue.number) }], ...author(issue.user, agent, bots), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: giteaChannel(issue.number, issue.html_url), url: issue.html_url, meta: { number: issue.number, isPr: false, kind: 'issue' } }
}
/** Builds the trigger for a newly opened pull request; Issue and pull request numbers share one sequence, so the ID format is the same. */
export function pullTrigger(pull: Opened, agent: string, bots: readonly string[]): Trigger {
  return { ...issueTrigger(pull, agent, bots), meta: { number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull' } }
}
/** Builds a trigger for a default-branch CI transition; it has no conversation to reply to, so it has no `channel`. */
export function branchCiTrigger(branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('gitea-ci', `branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${branch}` }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision } }
}
export function ciTrigger(pull: { number: number; html_url: string; user: { login: string } }, revision: number, summary: string): Trigger {
  return { id: key('gitea-ci', String(pull.number), String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: String(pull.number) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: giteaChannel(pull.number), url: pull.html_url,
    meta: { number: pull.number, isPr: true, prAuthor: pull.user.login, ci: true, revision } }
}
