#!/usr/bin/env node
// Aggregator: /export JSON -> exp/<id>/results.yaml
// Usage: node aggregate.mjs <export.json> <repo-root> <as_of YYYY-MM-DD> [id ...]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID_RE = /^E-[A-Za-z0-9_-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function nonNegInt(v, what) {
  if (!Number.isInteger(v) || v < 0) throw new Error(`${what} must be a non-negative integer`);
  return v;
}

function yamlStr(s) {
  return JSON.stringify(String(s)); // JSON strings are valid YAML double-quoted scalars
}

export function startedOn(firstEvent) {
  if (firstEvent === null || firstEvent === undefined) return null;
  const d = new Date(firstEvent);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid first_event: ${firstEvent}`);
  return d.toISOString().slice(0, 10);
}

export function renderResults(id, data, asOf) {
  if (!ID_RE.test(id)) throw new Error(`invalid experiment id: ${id}`);
  if (!DATE_RE.test(asOf)) throw new Error(`as_of must be YYYY-MM-DD: ${asOf}`);
  if (data === null || typeof data !== 'object') throw new Error(`${id}: entry must be an object`);
  const visits = nonNegInt(data.qualified_visits, `${id}.qualified_visits`);
  const wins = nonNegInt(data.primary_successes, `${id}.primary_successes`);
  const first = data.first_event ?? null;
  const started = startedOn(first);
  const by = data.by_source ?? {};
  if (typeof by !== 'object' || Array.isArray(by)) throw new Error(`${id}.by_source must be an object`);
  const lines = [
    `experiment: ${id}`,
    `as_of: ${asOf}`,
    `started_on: ${started === null ? 'null' : started}`,
    `first_event: ${first === null ? 'null' : yamlStr(first)}`,
    `qualified_visits: ${visits}`,
    `primary_successes: ${wins}`,
  ];
  const keys = Object.keys(by).sort();
  if (keys.length === 0) {
    lines.push('by_source: {}');
  } else {
    lines.push('by_source:');
    for (const k of keys) lines.push(`  ${yamlStr(k)}: ${nonNegInt(by[k], `${id}.by_source.${k}`)}`);
  }
  return lines.join('\n') + '\n';
}

export function aggregate(exportJson, repoRoot, asOf, ids) {
  const wanted = ids && ids.length ? ids : Object.keys(exportJson);
  const written = [];
  // validate everything first so a bad entry writes nothing
  const outputs = wanted.map((id) => {
    if (!ID_RE.test(id)) throw new Error(`invalid experiment id: ${id}`);
    if (!(id in exportJson)) throw new Error(`experiment not in export: ${id}`);
    return [id, renderResults(id, exportJson[id], asOf)];
  });
  for (const [id, text] of outputs) {
    const dir = join(resolve(repoRoot), 'exp', id);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'results.yaml');
    writeFileSync(file, text);
    written.push(file);
  }
  return written;
}

function main(argv) {
  const [exportPath, repoRoot, asOf, ...ids] = argv;
  if (!exportPath || !repoRoot || !asOf) {
    console.error('usage: node aggregate.mjs <export.json> <repo-root> <as_of YYYY-MM-DD> [id ...]');
    process.exit(2);
  }
  try {
    const data = JSON.parse(readFileSync(exportPath, 'utf8'));
    for (const f of aggregate(data, repoRoot, asOf, ids)) console.log(f);
  } catch (e) {
    console.error(`aggregate: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
