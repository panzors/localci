import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from './config.ts';

const base = { repo: 'owner/name', jobs: [{ name: 'ci', run: 'npm test' }] };

test('applies defaults', () => {
  const c = validateConfig(base);
  assert.deepEqual(
    { poll: c.pollSeconds, conc: c.concurrency, prs: c.pullRequests, keep: c.keepRuns, job: c.jobs[0] },
    { poll: 60, conc: 1, prs: false, keep: 10, job: { name: 'ci', run: 'npm test', locks: [], artifacts: [], timeoutMinutes: undefined } },
  );
});

test('error names the bad field', () => {
  const cases: [unknown, string][] = [
    [null, '"(root)"'],
    [{ ...base, repo: 'nope' }, '"repo"'],
    [{ ...base, pollSeconds: 0 }, '"pollSeconds"'],
    [{ ...base, concurrency: 1.5 }, '"concurrency"'],
    [{ ...base, branches: ['main', 3] }, '"branches"'],
    [{ ...base, pullRequests: 'yes' }, '"pullRequests"'],
    [{ ...base, jobs: [] }, '"jobs"'],
    [{ ...base, jobs: [{ name: 'a b', run: 'x' }] }, '"jobs[0].name"'],
    [{ ...base, jobs: [{ name: 'a', run: 'x' }, { name: 'a', run: 'y' }] }, '"jobs[1].name"'],
    [{ ...base, jobs: [{ name: 'a', run: '' }] }, '"jobs[0].run"'],
    [{ ...base, jobs: [{ name: 'a', run: 'x', locks: 'db' }] }, '"jobs[0].locks"'],
    [{ ...base, jobs: [{ name: 'a', run: 'x', timeoutMinutes: -1 }] }, '"jobs[0].timeoutMinutes"'],
    [{ ...base, pollSecond: 5 }, '"pollSecond"'],
    [{ ...base, jobs: [{ name: 'a', run: 'x', lock: [] }] }, '"jobs[0].lock"'],
  ];
  for (const [raw, field] of cases) assert.throws(() => validateConfig(raw), (e: Error) => e.message.includes(field), field);
});
