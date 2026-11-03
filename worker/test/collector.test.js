import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const COLS = ["id", "experiment", "visitor", "type", "kind", "source", "payload", "success", "ts", "day", "created"];

function fakeD1() {
  const rows = [];
  function exec(sql, a) {
    if (sql.startsWith("INSERT OR IGNORE INTO events")) {
      if (rows.some((r) => r.id === a[0])) return { meta: { changes: 0 } };
      const r = {};
      COLS.forEach((c, i) => (r[c] = a[i]));
      rows.push(r);
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("SELECT COUNT(*) AS n FROM events WHERE day = ? AND visitor = ?")) {
      return { n: rows.filter((r) => r.day === a[0] && r.visitor === a[1]).length };
    }
    if (sql.startsWith("SELECT COUNT(*) AS n FROM events WHERE day = ?")) {
      return { n: rows.filter((r) => r.day === a[0]).length };
    }
    if (sql.startsWith("DELETE FROM events WHERE visitor = ?")) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].visitor === a[0]) rows.splice(i, 1);
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("DELETE FROM events WHERE created < ?")) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].created < a[0]) rows.splice(i, 1);
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("SELECT experiment, visitor, type, source, success, ts FROM events")) {
      return { results: [...rows].sort((x, y) => x.ts - y.ts) };
    }
    throw new Error("fake D1: unsupported sql: " + sql);
  }
  return {
    rows,
    prepare(sql) {
      let args = [];
      const st = {
        bind(...a) { args = a; return st; },
        async run() { return exec(sql, args); },
        async all() { return exec(sql, args); },
        async first() { return exec(sql, args); },
      };
      return st;
    },
  };
}

const ORIGIN = "https://marketlab.pages.dev";
function mkEnv(extra = {}) {
  return {
    DB: fakeD1(),
    EXPERIMENTS: "E-001,E-002,E-003",
    SUCCESS_KINDS: "E-001:use_case,E-002:pilot,E-003:template",
    ALLOWED_ORIGINS: ORIGIN,
    EXPORT_KEY: "s3cret",
    ...extra,
  };
}
function call(env, method, path, body, headers = {}) {
  const init = { method, headers: { Origin: ORIGIN, ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return worker.fetch(new Request("https://w.example" + path, init), env);
}
const V1 = "visitor-0001";
const V2 = "visitor-0002";
const words = (n) => Array.from({ length: n }, (_, i) => "w" + i).join(" ");

test("health", async () => {
  const res = await call(mkEnv(), "GET", "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /e stores an event and returns 204", async () => {
  const env = mkEnv();
  const res = await call(env, "POST", "/e", { experiment: "E-001", visitor: V1, type: "visit", ts: 1000, source: "hn" });
  assert.equal(res.status, 204);
  assert.equal(env.DB.rows.length, 1);
  assert.equal(env.DB.rows[0].source, "hn");
});

test("rejects unknown experiment and bad visitor", async () => {
  const env = mkEnv();
  let res = await call(env, "POST", "/e", { experiment: "E-999", visitor: V1, type: "visit", ts: 1 });
  assert.equal(res.status, 400);
  res = await call(env, "POST", "/e", { experiment: "E-001", visitor: "x", type: "visit", ts: 1 });
  assert.equal(res.status, 400);
  assert.equal(env.DB.rows.length, 0);
});

test("replay of the same event id is stored once", async () => {
  const env = mkEnv();
  const body = { experiment: "E-001", visitor: V1, kind: "click", payload: {}, id: "evt-1" };
  assert.equal((await call(env, "POST", "/action", body)).status, 204);
  assert.equal((await call(env, "POST", "/action", body)).status, 204);
  assert.equal(env.DB.rows.length, 1);
});

test("global daily cap returns 429 and stops storing", async () => {
  const env = mkEnv({ DAILY_CAP: "2", VISITOR_CAP: "100" });
  for (let i = 0; i < 2; i++) {
    const r = await call(env, "POST", "/e", { experiment: "E-001", visitor: V1, type: "visit", ts: i });
    assert.equal(r.status, 204);
  }
  const res = await call(env, "POST", "/e", { experiment: "E-001", visitor: V2, type: "visit", ts: 99 });
  assert.equal(res.status, 429);
  assert.equal(env.DB.rows.length, 2);
});

test("per-visitor daily cap returns 429", async () => {
  const env = mkEnv({ VISITOR_CAP: "1" });
  assert.equal((await call(env, "POST", "/e", { experiment: "E-001", visitor: V1, type: "visit", ts: 1 })).status, 204);
  assert.equal((await call(env, "POST", "/e", { experiment: "E-001", visitor: V1, type: "view", ts: 2 })).status, 429);
  assert.equal((await call(env, "POST", "/e", { experiment: "E-001", visitor: V2, type: "visit", ts: 2 })).status, 204);
});

test("CORS: allowed origin echoed, other origin rejected", async () => {
  const env = mkEnv();
  let res = await call(env, "OPTIONS", "/e");
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  res = await call(env, "POST", "/e", { experiment: "E-001", visitor: V1, type: "visit", ts: 1 }, { Origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(env.DB.rows.length, 0);
});

test("success needs declared kind and >=50 words for use_case", async () => {
  const env = mkEnv();
  const a = (id, payload, exp = "E-001") => call(env, "POST", "/action", { experiment: exp, visitor: V1, kind: "submit", payload, id });
  await a("a-0001", { kind: "use_case", text: words(49) });
  await a("a-0002", { kind: "use_case", text: words(50) });
  await a("a-0003", { kind: "pilot", text: words(80) });
  await a("a-0004", { kind: "pilot" }, "E-002");
  assert.deepEqual(env.DB.rows.map((r) => r.success), [0, 1, 0, 1]);
});

test("POST /interview stores a non-success interview row", async () => {
  const env = mkEnv();
  const res = await call(env, "POST", "/interview", { experiment: "E-002", visitor: V1, payload: { note: "hi" }, id: "int-0001" });
  assert.equal(res.status, 204);
  assert.equal(env.DB.rows[0].type, "interview");
  assert.equal(env.DB.rows[0].success, 0);
});

test("GET /export requires the key and counts per experiment", async () => {
  const env = mkEnv();
  await call(env, "POST", "/e", { experiment: "E-001", visitor: V1, type: "visit", ts: 100, source: "hn" });
  await call(env, "POST", "/e", { experiment: "E-001", visitor: V1, type: "view", ts: 200 });
  await call(env, "POST", "/e", { experiment: "E-001", visitor: V2, type: "view", ts: 150 });
  await call(env, "POST", "/e", { experiment: "E-001", visitor: V2, type: "visit", ts: 300 });
  await call(env, "POST", "/action", { experiment: "E-001", visitor: V1, kind: "submit", payload: { kind: "use_case", text: words(60) }, id: "act-0001" });
  assert.equal((await call(env, "GET", "/export")).status, 403);
  assert.equal((await call(env, "GET", "/export?key=nope")).status, 403);
  const res = await call(env, "GET", "/export?key=s3cret");
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out["E-001"].qualified_visits, 1);
  assert.equal(out["E-001"].primary_successes, 1);
  assert.deepEqual(out["E-001"].by_source, { hn: 1 });
  assert.equal(out["E-001"].first_event, 100);
  assert.equal(out["E-002"].qualified_visits, 0);
  assert.equal(out["E-002"].first_event, null);
});

test("export is closed when EXPORT_KEY is unset", async () => {
  const env = mkEnv({ EXPORT_KEY: undefined });
  assert.equal((await call(env, "GET", "/export?key=undefined")).status, 403);
  assert.equal((await call(env, "GET", "/export?key=")).status, 403);
});

test("DELETE /visitor/:id removes only that visitor", async () => {
  const env = mkEnv();
  await call(env, "POST", "/e", { experiment: "E-001", visitor: V1, type: "visit", ts: 1 });
  await call(env, "POST", "/e", { experiment: "E-001", visitor: V2, type: "visit", ts: 1 });
  const res = await call(env, "DELETE", "/visitor/" + V1);
  assert.equal(res.status, 204);
  assert.deepEqual(env.DB.rows.map((r) => r.visitor), [V2]);
});

test("scheduled() deletes raw rows older than 90 days", async () => {
  const env = mkEnv();
  await call(env, "POST", "/e", { experiment: "E-001", visitor: V1, type: "visit", ts: 1 });
  await call(env, "POST", "/e", { experiment: "E-001", visitor: V2, type: "visit", ts: 1 });
  env.DB.rows[0].created = Date.now() - 91 * 86400000;
  await worker.scheduled({}, env);
  assert.equal(env.DB.rows.length, 1);
  assert.equal(env.DB.rows[0].visitor, V2);
});

test("no IP address is stored", async () => {
  const env = mkEnv();
  await call(env, "POST", "/e", { experiment: "E-001", visitor: V1, type: "visit", ts: 1 }, { "CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "203.0.113.7" });
  assert.ok(!JSON.stringify(env.DB.rows).includes("203.0.113.7"));
});

test("unknown route is 404 and bad json is 400", async () => {
  const env = mkEnv();
  assert.equal((await call(env, "GET", "/nope")).status, 404);
  assert.equal((await call(env, "POST", "/e", "{not json")).status, 400);
});
