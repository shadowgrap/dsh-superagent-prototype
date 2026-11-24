/** Gitea reads that produce the facts the app consumes, shaped as the github kind shapes them. */
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
