/** Gitea reads that produce the facts the app consumes, shaped as the github kind shapes them. */
import { z } from 'zod'
import { validItems, type Tally } from '../infra/commands.ts'
import type { Gt } from '../infra/gt.ts'
import { CommentSchema, type GiteaComment } from './gitea-trigger.ts'
import { commentTrigger } from './gitea-trigger.ts'

export interface CiStatus { id?: number; context: string; status: string }
/** A commit's checks and statuses; Gitea has no check runs, so `checks` stays empty. */
export interface CiSnapshot { head: string; checks: readonly unknown[]; statuses: { context: string; state: string }[] }

/** The latest status of each context, ordered by context, as `pullChecks` does for GitHub. */
export function ciSnapshot(head: string, statuses: readonly CiStatus[]): CiSnapshot {
  const latest = new Map<string, { id: number; state: string }>()
  for (const status of statuses) {
    const id = status.id ?? 0
    const seen = latest.get(status.context)
    if (!seen || id >= seen.id) latest.set(status.context, { id, state: status.status })
  }
  return { head, checks: [],
    statuses: [...latest].map(([context, { state }]) => ({ context, state })).sort((a, b) => a.context.localeCompare(b.context)) }
}

/** Gitea caps a response at 50 items, and its comment lists carry no `Link`, so pages are read until one is short. */
const PAGE_LIMIT = 50
/** Most pages one list read follows; a longer list fails the read so its cursor stays where it was, as the tea fork decides. */
const MAX_PAGES = 20
const StatusSchema = z.looseObject({ id: z.number().optional(), context: z.string(), status: z.string() })
/**
 * Reads a list by page until one is short. Gitea's list endpoints carry no `Link` header, so `--paginate` cannot be relied
 * on as it is for GitHub; every page names its number and limit instead.
 */
async function paged<T>(gt: Gt, item: z.ZodType<T>, path: (page: number) => string, tally?: Tally): Promise<T[]> {
  const items: T[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const listed = await gt.apiJson(z.array(z.unknown()), path(page))
    items.push(...validItems(item, listed, tally))
    if (listed.length < PAGE_LIMIT) return items
  }
  // Failing keeps the caller's cursor where it was, instead of stepping it past items this read never saw.
  throw new Error(`Gitea lists more than ${MAX_PAGES * PAGE_LIMIT} items for ${path(1).split('?')[0]}`)
}

/** Reads the commit statuses of `head`; an Actions run arrives as a status, so there is no check run to merge in. */
export async function readCi(gt: Gt, head: string, tally?: Tally): Promise<CiSnapshot> {
  return ciSnapshot(head, await paged(gt, StatusSchema, page => `commits/${head}/statuses?limit=${PAGE_LIMIT}&page=${page}`, tally))
}

/** A pull request as Gitea's API returns it, under the field names the github kind's `Pull` uses. */
const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: z.looseObject({ login: z.string() }),
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type GiteaPull = z.infer<typeof PullSchema> & { number: number }
/** Reads a pull request in the shape `claimPull` and `observePull` bind. */
export const readPull = async (gt: Gt, number: number): Promise<GiteaPull> =>
  ({ ...await gt.apiJson(PullSchema, `pulls/${number}`), number })

/** Every comment of a conversation; inline review comments have no repository-wide stream and arrive by notification instead. */
export async function conversationComments(gt: Gt, number: number, tally?: Tally): Promise<GiteaComment[]> {
  return paged(gt, CommentSchema, page => `issues/${number}/comments?limit=${PAGE_LIMIT}&page=${page}`, tally)
}

/**
 * A native `gt` list, which names a review's account `author` (a login, not an object), its commit `commit`, and its page `url`,
 * and an inline comment's line `old_line` where the API says `original_line`.
 */
async function nativePages<T>(gt: Gt, command: (page: number) => string[], fields: string[], item: z.ZodType<T>, tally?: Tally): Promise<T[]> {
  const items: T[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const listed: unknown[] = await gt.json(command(page), fields, z.array(z.unknown()))
    items.push(...validItems(item, listed, tally))
    if (listed.length < PAGE_LIMIT) return items
  }
  throw new Error(`Gitea lists more than ${MAX_PAGES * PAGE_LIMIT} items for ${command(1)[0]}`)
}
const NativeReview = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: z.string().nullish(), state: z.string().nullish(),
  submitted_at: z.string().nullish(), commit: z.string().nullish(), url: z.string().nullish(),
}).transform(({ author, commit, url, ...rest }) => ({ ...rest, user: { login: author ?? 'ghost' }, commit_id: commit, html_url: url }))
const NativeReviewComment = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: z.string().nullish(), path: z.string().nullish(), line: z.number().nullish(),
  old_line: z.number().nullish(), created_at: z.string().nullish(), updated_at: z.string().nullish(), url: z.string().nullish(),
}).transform(({ author, old_line, url, ...rest }) =>
  ({ ...rest, user: { login: author ?? 'ghost' }, original_line: old_line, html_url: url }))

/** Reads a pull request's reviews, at the submission time `gt` reports for them. */
export async function reviews(gt: Gt, number: number, tally?: Tally): Promise<GiteaComment[]> {
  return nativePages(gt, page => ['pr', 'review', 'list', String(number), `--limit=${PAGE_LIMIT}`, `--page=${page}`],
    ['id', 'body', 'author', 'state', 'submitted_at', 'commit', 'url'], NativeReview, tally) as Promise<GiteaComment[]>
}

/** Reads a pull request's inline review comments, which `gt` reports with the line the API leaves null. */
export async function reviewComments(gt: Gt, number: number, tally?: Tally): Promise<GiteaComment[]> {
  return nativePages(gt, page => ['pr', 'review', 'comments', String(number), `--limit=${PAGE_LIMIT}`, `--page=${page}`],
    ['id', 'body', 'author', 'path', 'line', 'old_line', 'created_at', 'updated_at', 'url'], NativeReviewComment, tally) as Promise<GiteaComment[]>
}

/** Reads a non-hidden file of the repository; hidden entries and `node_modules` are rejected as for the github kind. */
export async function readPath(gt: Gt, path: string): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules'))
    throw new Error('Only non-hidden repository source paths are available')
  return gt.api(`raw/${parts.map(encodeURIComponent).join('/')}`)
}
