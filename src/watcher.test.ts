import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLsRemote } from './git.ts';
import type { State } from './state.ts';
import { applyPoll, trackedRefs } from './watcher.ts';

const remote = parseLsRemote([
  'aaa\trefs/heads/main',
  'bbb\trefs/heads/other',
  'ccc\trefs/pull/7/head',
  'ddd\trefs/pull/8/head',
  '',
].join('\n'));

const fresh = (): State => ({ paused: false, seen: {}, openPrs: [], queue: [], active: [], locks: {}, outbox: [] });

test('tracks only configured branches and open PRs', () => {
  assert.deepEqual(trackedRefs(remote, ['main', 'missing'], [7]), [
    { ref: 'main', sha: 'aaa' },
    { ref: 'pr-7', sha: 'ccc', pr: 7 },
  ]);
});

test('queues new and changed SHAs once', () => {
  const s = fresh();
  applyPoll(s, [{ ref: 'main', sha: 'aaa' }]);
  assert.deepEqual(s.queue, [{ ref: 'main', sha: 'aaa' }]);
  applyPoll(s, [{ ref: 'main', sha: 'aaa' }]);
  assert.equal(s.queue.length, 1, 'unchanged SHA is not re-queued');
  applyPoll(s, [{ ref: 'main', sha: 'a2' }]);
  assert.deepEqual(s.queue, [{ ref: 'main', sha: 'a2' }], 'newer SHA replaces the queued one');
});

test('returns refs whose running run is stale', () => {
  const s = fresh();
  s.seen = { main: 'aaa' };
  s.active = [{ ref: 'main', sha: 'aaa', slot: 0, dir: 'x' }];
  assert.deepEqual(applyPoll(s, [{ ref: 'main', sha: 'aaa' }]), []);
  assert.deepEqual(applyPoll(s, [{ ref: 'main', sha: 'bbb' }]), ['main']);
});

test('drops closed PRs but keeps manual runs of untracked refs', () => {
  const s = fresh();
  applyPoll(s, [{ ref: 'pr-7', sha: 'ccc', pr: 7 }]);
  s.queue.push({ ref: 'feature', sha: 'fff' });
  applyPoll(s, []);
  assert.deepEqual(s.seen, {});
  assert.deepEqual(s.queue, [{ ref: 'feature', sha: 'fff' }]);
});
