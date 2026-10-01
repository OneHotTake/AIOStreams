import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceSearchScheduler, sourceSearchContext } from './source-search.js';

test('a shared scheduler bounds independent lookup traffic and gives foreground work priority', async () => {
  const scheduler = new SourceSearchScheduler(1);
  const order: string[] = [];
  let release!: () => void;
  const first = scheduler.schedule(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        order.push('first');
      }),
    { maintenance: true }
  );
  const second = scheduler.schedule(
    async () => {
      order.push('maintenance');
    },
    { maintenance: true }
  );
  const playback = scheduler.schedule(
    async () => {
      order.push('playback');
    },
    { maintenance: false }
  );
  await new Promise(setImmediate);
  assert.equal(scheduler.active, 1);
  assert.equal(scheduler.queued, 2);
  release();
  await Promise.all([first, second, playback]);
  assert.deepEqual(order, ['first', 'playback', 'maintenance']);
  assert.equal(scheduler.active, 0);
});
test('expired and cancelled queued work never reaches its source', async () => {
  const scheduler = new SourceSearchScheduler(1, 2);
  let release!: () => void,
    calls = 0;
  const first = scheduler.schedule(
    () => new Promise<void>((resolve) => (release = resolve))
  );
  const abort = new AbortController();
  const cancelled = scheduler.schedule(
    async () => {
      calls++;
    },
    { maintenance: true, signal: abort.signal }
  );
  const expired = scheduler.schedule(
    async () => {
      calls++;
    },
    { maintenance: true },
    10
  );
  await assert.rejects(
    scheduler.schedule(async () => {}),
    /queue full/
  );
  abort.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  await assert.rejects(expired, /queue deadline/);
  release();
  await first;
  assert.equal(calls, 0);
  assert.equal(scheduler.queued, 0);
});
test('queued transports retain their own cancellation context when the preceding request drains them', async () => {
  const scheduler = new SourceSearchScheduler(1);
  let release!: () => void;
  const firstSignal = new AbortController().signal,
    secondSignal = new AbortController().signal;
  const first = scheduler.schedule(
    () => new Promise<void>((resolve) => (release = resolve)),
    { maintenance: true, signal: firstSignal }
  );
  const second = scheduler.schedule(
    async () => {
      assert.equal(sourceSearchContext.getStore()?.signal, secondSignal);
      assert.equal(sourceSearchContext.getStore()?.maintenance, false);
    },
    { maintenance: false, signal: secondSignal }
  );
  await new Promise(setImmediate);
  release();
  await Promise.all([first, second]);
});
