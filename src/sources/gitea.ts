/** Gitea Source: the notification round, which reads each notified Issue or PR and the comments its own cursor leaves out. */
import { z } from 'zod'
import { validItems, CliError, type Tally } from '../infra/commands.ts'
import type { Gt } from '../infra/gt.ts'
import { KV } from '../kv.ts'
import { sameName } from '../infra/text.ts'
import { giteaTransport } from './gitea-channel.ts'
import { conversationComments, reviewComments, reviews } from './gitea-read.ts'
import { commentTrigger, inlineRoot, issueTrigger, IssueSchema, pullTrigger, type GiteaComment, type PullRef } from './gitea-trigger.ts'
import type { SourceContext } from './host.ts'
import { cursorAt } from './poll.ts'

/**
 * Gitea writes a notification about six seconds after its event, so every round lists the two minutes before its cursor
 * again; Trigger IDs make the repeated comments no-ops. The shared `cursorAt` stays untouched, so Feishu and GitHub polling
 * keep their five seconds.
 */
export const NOTIFICATION_OVERLAP_MS = 120_000
/** Gitea's largest page (`max_response_items` defaults to 50), and most pages one round follows. */
const PAGE_LIMIT = 50
const MAX_PAGES = 20
const RETRY_WINDOW_MS = 24 * 3600_000
/** A notification of the agent account; Gitea names the Issue or PR by `number` and `type`, so no address is parsed. */
const NotificationSchema = z.looseObject({
  id: z.number(), number: z.number(), type: z.string(), state: z.string().nullish(),
  title: z.string().nullish(), updated_at: z.string(),
})
const NOTIFICATION_FIELDS = ['id', 'number', 'type', 'state', 'unread', 'updated_at', 'title']
type Notification = z.infer<typeof NotificationSchema>
/** An Issue or PR whose last read failed, retried from the same point for up to a day. */
export interface GiteaRetry { since: string; pr: boolean; failedAt?: string; attempts?: number }

/** Every notification about an Issue or PR updated since `since`, oldest first, by page. */
export async function notificationsSince(gt: Gt, since: string, tally?: Tally): Promise<Notification[]> {
  const items: Notification[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const listed: unknown[] = await gt.json(['notification', 'list', `--since=${since}`, '--status=unread,read,pinned',
      `--limit=${PAGE_LIMIT}`, `--page=${page}`], NOTIFICATION_FIELDS, z.array(z.unknown()))
    // Repository and commit notifications name no Issue or PR, so they carry no conversation to read.
    const aboutConversations = listed.filter(item => ['issue', 'pull'].includes(String((item as { type?: unknown }).type)))
    items.push(...validItems(NotificationSchema, aboutConversations, tally))
    if (listed.length < PAGE_LIMIT) break
  }
  return items.sort((a, b) => a.updated_at.localeCompare(b.updated_at))
}

interface Round {
  started: string; signal?: AbortSignal | undefined
  read: Set<number>; failures: string[]; dropped: number[]; abandoned: number[]; tally: Tally
}
export const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal,
  read: new Set(), failures: [], dropped: [], abandoned: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config('gitea')
/** Gitea answers 404 for an Issue it deleted; a repository that still reads makes the missing Issue a deleted one. */
async function deletedIssue(gt: Gt, error: unknown): Promise<boolean> {
  if (!(error instanceof CliError) || !(error.code === 404 || /not found|404/i.test(error.message))) return false
  return gt.apiJson(z.looseObject({ full_name: z.string() }), '').then(() => true, () => false)
}
/** Records a failed read on the Thread and in the round; a deleted Issue is dropped and does not fail the round. */
function failed(ctx: SourceContext, round: Round, number: number, error: unknown, deleted: boolean, abandoned = false): void {
  if (deleted) round.dropped.push(number)
  else if (abandoned) round.abandoned.push(number)
  else round.failures.push(`#${number}: ${String(error)}`)
  ctx.threads.patch(`gitea:${number}`, { pollError: String(error) })
}
function nameThread(ctx: SourceContext, number: number, title: string): void {
  ctx.threads.patch(`gitea:${number}`, { title })
  ctx.threads.describe(`gitea:${number}`, { label: `#${number} ${title}`, facts: { number: { value: `#${number}` } } })
}
/**
 * Polls notifications since the cursor and reads each Issue or PR they name, advancing the cursor together with the retry
 * map so a failed read is retried from where it started.
 * @returns how many notifications this round listed.
 */
export async function pollNotifications(ctx: SourceContext, round: Round): Promise<number> {
  const { state } = ctx
  const gt = giteaTransport(round.signal ? ctx.commands.withSignal(round.signal) : ctx.commands)
  const agent = ctx.deployment.gitea?.login ?? ''
  const since = state.get(KV.gitea.since) ?? round.started
  if (state.get(KV.gitea.since) === undefined) state.set(KV.gitea.since, since)
  const overlap = new Date(Date.parse(since) - NOTIFICATION_OVERLAP_MS).toISOString()
  const notifications = await notificationsSince(gt, overlap, round.tally)
  const retries: Record<string, GiteaRetry> = { ...state.get(KV.gitea.retries) }
  const items = new Map<number, GiteaRetry>(Object.entries(retries).map(([number, retry]) => [Number(number), retry]))
  for (const notification of notifications) {
    if (items.has(notification.number)) continue
    const pr = notification.type === 'pull'
    items.set(notification.number, { since: [state.get(KV.gitea.cursor(notification.number)) ?? since, since].sort().at(-1)!, pr })
  }
  for (const [number, item] of items) {
    if (stopped(ctx, round)) return notifications.length
    round.read.add(number)
    try {
      await readNotified(ctx, round, number, item, agent)
      delete retries[number]
    } catch (error) {
      if (stopped(ctx, round)) return notifications.length
      const failedAt = item.failedAt ?? round.started
      const retry: GiteaRetry = { ...item, failedAt, attempts: (item.attempts ?? 0) + 1 }
      // A thread unreadable for a day stops failing the Source's health; its cursor stays, so a later notification reads what was missed.
      const abandoned = Date.parse(round.started) - Date.parse(failedAt) >= RETRY_WINDOW_MS
      const deleted = await deletedIssue(gt, error).catch(() => false)
      failed(ctx, round, number, error, deleted, abandoned)
      if (deleted || abandoned) delete retries[number]
      else retries[number] = retry
    }
  }
  ctx.atomic(() => { state.set(KV.gitea.since, cursorAt(round.started)); state.set(KV.gitea.retries, retries) })
  return notifications.length
}

/** Reads the Issue or PR a notification names: its body when someone else opened it since the cursor, and its comments since. */
async function readNotified(ctx: SourceContext, round: Round, number: number, item: GiteaRetry, agent: string): Promise<void> {
  const gt = giteaTransport(ctx.commands)
  const issue = await gt.apiJson(IssueSchema, `issues/${number}`)
  const isPr = item.pr || (issue as { pull_request?: unknown }).pull_request != null
  const since = item.since
  const ref: PullRef = { number, isPr, url: issue.html_url, ...isPr ? { prAuthor: issue.user.login } : {} }
  if (!isPr && Date.parse(issue.created_at) >= Date.parse(since) && !sameName(issue.user.login, agent))
    await ctx.receive(issueTrigger(issue, agent, []))
  await intakeComments(ctx, round, ref, since, agent)
  ctx.state.set(KV.gitea.cursor(number), cursorAt(round.started))
  ctx.threads.patch(`gitea:${number}`, { pollError: undefined })
  if (issue.title) nameThread(ctx, number, issue.title)
}

/** Reads the comments of a conversation since `since`: the conversation's, and for a pull request its inline comments and reviews. */
async function intakeComments(ctx: SourceContext, round: Round, ref: PullRef, since: string, agent: string): Promise<void> {
  const gt = giteaTransport(ctx.commands)
  // ponytail: the Policy's bot list is not on SourceContext yet, so every account but the agent's counts as a person here; the
  // Policy's allowed list still decides whether it may originate work.
  const bots: string[] = []
  await receive(ctx, round, ref, await conversationComments(gt, ref.number, round.tally), 'conversation', since, agent, bots)
  if (!ref.isPr) return
  const inline = await reviewComments(gt, ref.number, round.tally)
  for (const comment of inline) {
    if (stopped(ctx, round)) throw new Error('The Gitea Source stopped during the poll')
    if (sameName(comment.user.login, agent)) continue
    const at = Date.parse(comment.created_at ?? '')
    if (!Number.isFinite(at) || at < Date.parse(since)) continue
    const trigger = commentTrigger(comment, ref, 'inline', agent, bots, inlineRoot(comment, inline)?.id)
    if (trigger.text) await ctx.receive(trigger)
  }
  await receive(ctx, round, ref, await reviews(gt, ref.number, round.tally), 'review', since, agent, bots)
}

async function receive(ctx: SourceContext, round: Round, ref: PullRef, comments: GiteaComment[], kind: 'conversation' | 'review',
  since: string, agent: string, bots: string[]): Promise<void> {
  for (const comment of comments) {
    if (stopped(ctx, round)) throw new Error('The Gitea Source stopped during the poll')
    if (sameName(comment.user.login, agent)) continue
    const at = Date.parse(comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? '')
    if (!Number.isFinite(at) || at < Date.parse(since)) continue
    // A review with no body still reaches the ticket: a worker may be waiting for that decision.
    const trigger = commentTrigger(comment, ref, kind, agent, bots)
    if (trigger.text) await ctx.receive(trigger)
  }
}
