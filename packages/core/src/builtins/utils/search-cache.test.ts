import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedSourceSearch } from './search-cache.js';
class Memory<T> {
  private rows = new Map<string, { value: T; expires: number }>();
  constructor(private now: () => number) {}
  async get(key: string) {
    const v = this.rows.get(key);
    return v && v.expires > this.now() ? v.value : undefined;
  }
  async set(key: string, value: T, ttl: number) {
    this.rows.set(key, { value, expires: this.now() + ttl * 1000 });
  }
}
function fixture(key: string) {
  let time = 100000,
    calls = 0;
  const now = () => time;
  const cache = new Memory<number[]>(now),
    refreshState = new Memory<{ until: number; failures: number }>(now);
  const o = {
    key,
    cache,
    refreshState,
    ttl: 1000,
    emptyTTL: 120,
    refreshInterval: 10,
    now,
    isEmpty: (v: number[]) => v.length === 0,
    fetch: async () => {
      calls++;
      return [1];
    },
  };
  return { o, advance: (ms: number) => (time += ms), calls: () => calls };
}
test('concurrent episode lookups share one season fetch and then reuse it', async () => {
  const f = fixture('season');
  const results = await Promise.all(
    Array.from({ length: 20 }, () => cachedSourceSearch(f.o))
  );
  assert.equal(f.calls(), 1);
  assert.ok(results.every((r) => r[0] === 1));
  await cachedSourceSearch(f.o);
  assert.equal(f.calls(), 1);
});
test('empty season results are shared and expire promptly without a positive cooldown blocking the retry', async () => {
  const f = fixture('empty');
  f.o.fetch = async () => [];
  let calls = 0;
  const original = f.o.fetch;
  f.o.fetch = async () => {
    calls++;
    return original();
  };
  await Promise.all(Array.from({ length: 20 }, () => cachedSourceSearch(f.o)));
  assert.equal(calls, 1);
  f.advance(119000);
  await cachedSourceSearch(f.o);
  assert.equal(calls, 1);
  f.advance(2000);
  await cachedSourceSearch(f.o);
  assert.equal(calls, 2);
});
test('foreground failures escalate backoff and are never cached as an empty success', async () => {
  const f = fixture('errors');
  let calls = 0;
  f.o.fetch = async () => {
    calls++;
    throw new Error('provider unavailable');
  };
  await assert.rejects(cachedSourceSearch(f.o));
  await assert.rejects(cachedSourceSearch(f.o), /backing off/);
  assert.equal(calls, 1);
  f.advance(15000);
  await assert.rejects(cachedSourceSearch(f.o));
  assert.equal(calls, 2);
  f.advance(59000);
  await assert.rejects(cachedSourceSearch(f.o), /backing off/);
  assert.equal(calls, 2);
  f.advance(1000);
  await assert.rejects(cachedSourceSearch(f.o));
  assert.equal(calls, 3);
  assert.equal(await f.o.cache.get(f.o.key), undefined);
});
test('failed or empty background refresh retains the good inventory and has a cooldown', async () => {
  const f = fixture('background');
  await cachedSourceSearch(f.o);
  f.advance(11000);
  let refreshes = 0;
  f.o.fetch = async () => {
    refreshes++;
    throw new Error('down');
  };
  assert.deepEqual(await cachedSourceSearch(f.o), [1]);
  await new Promise(setImmediate);
  await cachedSourceSearch(f.o);
  await new Promise(setImmediate);
  assert.equal(refreshes, 1);
  f.advance(16000);
  f.o.fetch = async () => {
    refreshes++;
    return [];
  };
  assert.deepEqual(await cachedSourceSearch(f.o), [1]);
  await new Promise(setImmediate);
  assert.deepEqual(await cachedSourceSearch(f.o), [1]);
  assert.equal(refreshes, 2);
});
