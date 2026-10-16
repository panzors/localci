import type { QueuedRun, State } from './state.ts';

/** Configured branches plus open PRs that exist on the remote (FR-2.3). PR refs are named "pr-<n>". */
export function trackedRefs(remote: Map<string, string>, branches: string[], prs: number[]): QueuedRun[] {
  const out: QueuedRun[] = [];
  for (const ref of branches) {
    const sha = remote.get(`refs/heads/${ref}`);
    if (sha) out.push({ ref, sha });
  }
  for (const pr of prs) {
    const sha = remote.get(`refs/pull/${pr}/head`);
    if (sha) out.push({ ref: `pr-${pr}`, sha, pr });
  }
  return out;
}

/** Queues changed refs and drops vanished ones (FR-2.4, FR-2.6). Returns refs whose running run is now stale (FR-2.5). */
export function applyPoll(s: State, current: QueuedRun[]): string[] {
  const live = new Set(current.map(r => r.ref));
  const gone = Object.keys(s.seen).filter(ref => !live.has(ref));
  for (const ref of gone) delete s.seen[ref];
  s.queue = s.queue.filter(q => !gone.includes(q.ref));

  const stale: string[] = [];
  for (const r of current) {
    if (s.seen[r.ref] === r.sha) continue;
    s.seen[r.ref] = r.sha;
    s.queue = s.queue.filter(q => q.ref !== r.ref);
    s.queue.push(r);
    if (s.active.some(a => a.ref === r.ref)) stale.push(r.ref);
  }
  return stale;
}
