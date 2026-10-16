import type { StatusPost } from './state.ts';

function gh(path: string, init: RequestInit = {}) {
  const token = process.env.LCI_GITHUB_TOKEN;
  return fetch(`https://api.github.com${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'localci',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string>),
    },
  });
}

/** Open PR numbers, or null when the ETag still matches (304 costs no quota). */
// shortcut: reads only the first 100 open PRs; paginate if the repo ever has more.
export async function openPullRequests(repo: string, etag?: string): Promise<{ prs: number[]; etag?: string } | null> {
  const res = await gh(`/repos/${repo}/pulls?state=open&per_page=100`, { headers: etag ? { 'If-None-Match': etag } : {} });
  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`GitHub returned ${res.status} listing pull requests`);
  const body = (await res.json()) as { number: number }[];
  return { prs: body.map(p => p.number), etag: res.headers.get('etag') ?? undefined };
}

/** Returns the HTTP status; network errors throw. */
export async function postStatus(repo: string, s: StatusPost): Promise<number> {
  const res = await gh(`/repos/${repo}/statuses/${s.sha}`, {
    method: 'POST',
    body: JSON.stringify({ state: s.state, context: s.context, description: s.description.slice(0, 140) }),
  });
  return res.status;
}
