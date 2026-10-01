import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache, initDb, closeDb, initialiseConfig } from '../../index.js';
import { cachedSourceSearch } from './search-cache.js';

test('season inventory and refresh cooldown persist in the real SQL cache across a database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aio-season-cache-'));
  const uri = `sqlite://${join(directory, 'fixture.db')}`;
  let calls = 0;
  try {
    await initDb(uri);
    await initialiseConfig();
    const cache = Cache.getInstance<string, string[]>(
      'season-fixture',
      undefined,
      'sql'
    );
    const refreshState = Cache.getInstance<
      string,
      { until: number; failures: number }
    >('season-fixture-refresh', undefined, 'sql');
    const options = {
      key: 'fixture-s01',
      cache,
      refreshState,
      ttl: 3600,
      emptyTTL: 120,
      refreshInterval: 900,
      isEmpty: (v: string[]) => v.length === 0,
      fetch: async () => {
        calls++;
        return ['S01E01', 'S01E02'];
      },
    };
    await cachedSourceSearch(options);
    await cachedSourceSearch(options);
    await new Promise(setImmediate);
    assert.equal(
      calls,
      1,
      'a buffered refresh stamp must not launch an immediate second search'
    );
    assert.ok((await refreshState.get(options.key))!.until > Date.now());
    await closeDb();
    await initDb(uri);
    assert.deepEqual(await cachedSourceSearch(options), ['S01E01', 'S01E02']);
    await new Promise(setImmediate);
    assert.equal(calls, 1);
  } finally {
    await closeDb();
    await rm(directory, { recursive: true, force: true });
  }
});
