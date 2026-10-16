import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Locks } from './locks.ts';

const tick = () => new Promise(r => setImmediate(r));

test('second holder waits for release', async () => {
  const locks = new Locks();
  const releaseA = await locks.acquire(['db'], 'a');
  let gotB = false;
  const b = locks.acquire(['db'], 'b').then(r => { gotB = true; return r; });
  await tick();
  assert.equal(gotB, false);
  releaseA();
  (await b)();
  assert.equal(locks.held.size, 0);
});

test('disjoint locks do not block each other', async () => {
  const locks = new Locks();
  await locks.acquire(['db'], 'a');
  await locks.acquire(['browser'], 'b');
  assert.deepEqual(Object.fromEntries(locks.held), { db: 'a', browser: 'b' });
});

test('takes all locks at once and later waiters cannot jump the queue', async () => {
  const locks = new Locks();
  const releaseX = await locks.acquire(['x'], 'a');
  const order: string[] = [];
  const both = locks.acquire(['x', 'y'], 'b').then(r => { order.push('b'); return r; });
  const onlyY = locks.acquire(['y'], 'c').then(r => { order.push('c'); return r; });
  await tick();
  assert.equal(locks.held.has('y'), false, 'y stays free for the earlier waiter');
  releaseX();
  (await both)();
  (await onlyY)();
  assert.deepEqual(order, ['b', 'c']);
});

test('abort while waiting rejects and holds nothing', async () => {
  const locks = new Locks();
  const release = await locks.acquire(['db'], 'a');
  const ctrl = new AbortController();
  const waiting = locks.acquire(['db', 'other'], 'b', ctrl.signal);
  ctrl.abort();
  await assert.rejects(waiting);
  release();
  assert.equal(locks.held.size, 0);
});
