import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, renderResults, startedOn } from './aggregate.mjs';

const sample = {
  'E-001': {
    qualified_visits: 120,
    primary_successes: 9,
    by_source: { reddit: 70, hn: 50 },
    first_event: '2026-10-28T14:03:11Z',
  },
  'E-002': { qualified_visits: 0, primary_successes: 0, by_source: {}, first_event: null },
};

test('renders all required keys in order', () => {
  const y = renderResults('E-001', sample['E-001'], '2026-11-03');
  assert.equal(
    y,
    [
      'experiment: E-001',
      'as_of: 2026-11-03',
      'started_on: 2026-10-28',
      'first_event: "2026-10-28T14:03:11Z"',
      'qualified_visits: 120',
      'primary_successes: 9',
      'by_source:',
      '  "hn": 50',
      '  "reddit": 70',
      '',
    ].join('\n'),
  );
});

test('null first_event gives null started_on and empty by_source', () => {
  const y = renderResults('E-002', sample['E-002'], '2026-11-03');
  assert.match(y, /^started_on: null$/m);
  assert.match(y, /^first_event: null$/m);
  assert.match(y, /^by_source: \{\}$/m);
});

test('started_on is the UTC date of first_event', () => {
  assert.equal(startedOn('2026-10-28T23:59:59Z'), '2026-10-28');
  assert.equal(startedOn('2026-10-29T01:00:00+02:00'), '2026-10-28');
  assert.equal(startedOn(null), null);
  assert.throws(() => startedOn('nope'));
});

test('writes only exp/<id>/results.yaml', () => {
  const root = mkdtempSync(join(tmpdir(), 'agg-'));
  const files = aggregate(sample, root, '2026-11-03');
  assert.equal(files.length, 2);
  assert.ok(existsSync(join(root, 'exp', 'E-001', 'results.yaml')));
  assert.ok(existsSync(join(root, 'exp', 'E-002', 'results.yaml')));
  assert.deepEqual(readdirSync(root), ['exp']);
  assert.deepEqual(readdirSync(join(root, 'exp', 'E-001')), ['results.yaml']);
});

test('id list restricts output', () => {
  const root = mkdtempSync(join(tmpdir(), 'agg-'));
  aggregate(sample, root, '2026-11-03', ['E-002']);
  assert.deepEqual(readdirSync(join(root, 'exp')), ['E-002']);
});

test('rejects bad input and writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'agg-'));
  assert.throws(() => aggregate(sample, root, '2026-11-03', ['../x']));
  assert.throws(() => aggregate(sample, root, '2026-11-03', ['E-999']));
  assert.throws(() => aggregate(sample, root, 'Nov 3'));
  assert.throws(() =>
    aggregate({ 'E-001': { qualified_visits: -1, primary_successes: 0, by_source: {} } }, root, '2026-11-03'),
  );
  assert.equal(existsSync(join(root, 'exp')), false);
});
