import { test, before } from 'node:test';
import assert from 'node:assert/strict';
// Exercise the application's normal public-module initialization order; direct
// isolated addon imports hit an existing upstream preset/base-class cycle.
import {
  ProwlarrAddon,
  settingsStore,
  SettingsRepository,
} from '../../index.js';
import ProwlarrApi from './api.js';
import { IdParser } from '../../utils/id-parser.js';
import { cachedSourceSearch } from '../utils/search-cache.js';
import { SourceSearchScheduler } from '../../utils/source-search.js';

before(async () => {
  // Validate normal defaults without any service, credentials or production DB.
  SettingsRepository.getAll = async () => [];
  SettingsRepository.getVersion = async () => 0;
  await settingsStore.initialise();
});

class Memory<T> {
  rows = new Map<string, T>();
  async get(key: string) {
    return this.rows.get(key);
  }
  async set(key: string, value: T) {
    this.rows.set(key, value);
  }
}
function subject(search: (q: string) => Promise<{ data: any[] }>) {
  const addon = new ProwlarrAddon({
    services: [],
    url: 'https://example.invalid',
    apiKey: 'fixture',
    indexers: [],
    tags: [],
    checkOwned: true,
  });
  const internal = addon as any;
  internal.getIndexersByProtocol = async () => [{ id: 1 }];
  addon.api.search = async ({ query }) => search(query) as any;
  return internal;
}
test('ten concurrent episode lookups perform one raw season fetch and locally select ten different episodes', async () => {
  const cache = new Memory<{ data: any[] }>(),
    refreshState = new Memory<{ until: number; failures: number }>();
  const scheduler = new SourceSearchScheduler(1);
  let searches = 0;
  const inventory = Array.from({ length: 10 }, (_, i) => ({
    title: `Example.Show.S01E${String(i + 1).padStart(2, '0')}.1080p.WEB-DL`,
  }));
  const search = async (query: string) =>
    cachedSourceSearch({
      key: query,
      cache,
      refreshState,
      ttl: 3600,
      emptyTTL: 120,
      refreshInterval: 900,
      isEmpty: (v) => v.data.length === 0,
      fetch: () =>
        scheduler.schedule(async () => {
          searches++;
          return { data: inventory };
        }),
    });
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      subject(search).performSearch(
        'torrent',
        IdParser.parse(`tt999999999:1:${i + 1}`, 'series'),
        { primaryTitle: 'Example Show', titles: ['Example Show'] }
      )
    )
  );
  assert.equal(searches, 1);
  assert.ok(
    results.every((r, i) => r.length === 1 && r[0].title === inventory[i].title)
  );
});
test('an uncovered episode uses exact fallback; a validated-file failure can request exact fallback without repeating the season', async () => {
  const queries: string[] = [];
  const addon = subject(async (q) => {
    queries.push(q);
    return {
      data: q.endsWith('s01')
        ? [{ title: 'Example.Show.S01E01.1080p.WEB-DL' }]
        : [],
    };
  });
  const metadata = { primaryTitle: 'Example Show', titles: ['Example Show'] };
  await addon.performSearch(
    'usenet',
    IdParser.parse('tt999999999:1:2', 'series'),
    metadata
  );
  assert.deepEqual(queries, ['example show s01', 'example show s01e02']);
  queries.length = 0;
  await addon.performSearch(
    'torrent',
    IdParser.parse('tt999999999:1:1', 'series'),
    metadata
  );
  addon.onProcessedSources('torrent', 0);
  assert.ok(addon.unmatchedProtocols.has('torrent'));
  addon.exactProtocols.add('torrent');
  await addon.performSearch(
    'torrent',
    IdParser.parse('tt999999999:1:1', 'series'),
    metadata
  );
  assert.deepEqual(queries, ['example show s01', 'example show s01e01']);
});
test('query cache scope normalizes indexer order and titles while isolating API credentials', async () => {
  const cache = new Memory<any>(),
    refreshState = new Memory<any>();
  let calls = 0;
  function api(key: string) {
    const a = new ProwlarrApi({
      baseUrl: 'https://example.invalid',
      apiKey: key,
      timeout: 1000,
    }) as any;
    a.searchCache = cache;
    a.refreshState = refreshState;
    a.request = async () => {
      calls++;
      return { data: [] };
    };
    return a;
  }
  const a = api('first'),
    b = api('second');
  await a.search({
    query: ' Example  S01 ',
    indexerIds: [2, 1],
    type: 'search',
  });
  await a.search({ query: 'example s01', indexerIds: [1, 2], type: 'search' });
  assert.equal(calls, 1);
  await b.search({ query: 'example s01', indexerIds: [1, 2], type: 'search' });
  assert.equal(calls, 2);
});
