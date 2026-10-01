import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  uniqueSearchQueries,
  seasonSearchQueries,
  selectSeasonResults,
} from './season-search.js';
test('season inventories select the requested episode or pack without guessing other seasons/unknown numbering', () => {
  const rows = [
    { title: 'Example.Show.S01E01.1080p.WEB-DL' },
    { title: 'Example.Show.S01E02.1080p.WEB-DL' },
    { title: 'Example.Show.S02E01.1080p.WEB-DL' },
    { title: 'Example.Show.S01.COMPLETE.1080p.WEB-DL' },
    { title: 'Example.Show.001.1080p.WEB-DL' },
  ];
  assert.deepEqual(selectSeasonResults(rows, 1, 1), [rows[0], rows[3]]);
  assert.deepEqual(selectSeasonResults(rows, 2, 1), [rows[2]]);
});
test('query normalization shares season keys and preserves absolute/date/title variants for fallback', () => {
  const queries = uniqueSearchQueries([
    ' Show  S01 ',
    'show s01',
    'Show S01E01',
    'Show 01',
    'Show 2026 10 01',
  ]);
  assert.equal(queries.length, 4);
  assert.deepEqual(seasonSearchQueries(queries, 1), ['show s01']);
  assert.deepEqual(seasonSearchQueries(['show 012', 'show 2026 10 01'], 1), []);
});
