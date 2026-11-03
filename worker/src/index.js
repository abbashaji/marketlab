// Marketlab collector: Cloudflare Worker, plain ES modules, no dependencies.
// No IP is read or stored. Visitor ids are first-party pseudonymous ids chosen by the client.

const DAY_MS = 86400000;
const RETENTION_MS = 90 * DAY_MS;
const MAX_BODY = 8192;
const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_:.-]{1,100}$/;
const WORD_RE = /^[a-z_]{1,32}$/;
const SOURCE_RE = /^[A-Za-z0-9_.-]{1,32}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function list(s) {
  return String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function intVar(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function successKinds(env) {
  const map = {};
  for (const pair of list(env.SUCCESS_KINDS)) {
    const [exp, kind] = pair.split(":").map((x) => x.trim());
    if (exp && kind) map[exp] = kind;
  }
  return map;
}

function wordCount(text) {
  return String(text == null ? "" : text).trim().split(/\s+/).filter(Boolean).length;
}

function corsHeaders(req, env) {
  const h = { Vary: "Origin" };
  const origin = req.headers.get("Origin");
  if (origin && list(env.ALLOWED_ORIGINS).includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function reply(status, headers, body) {
  if (body === undefined) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function checkOrigin(req, env) {
  const origin = req.headers.get("Origin");
  if (origin && !list(env.ALLOWED_ORIGINS).includes(origin)) {
    throw new HttpError(403, "origin not allowed");
  }
}

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "body too large");
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new HttpError(400, "invalid json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid body");
  }
  return body;
}

function checkCommon(body, env) {
  if (typeof body.experiment !== "string" || !list(env.EXPERIMENTS).includes(body.experiment)) {
    throw new HttpError(400, "unknown experiment");
  }
  if (typeof body.visitor !== "string" || !VISITOR_RE.test(body.visitor)) {
    throw new HttpError(400, "invalid visitor");
  }
}

function cleanTs(ts, now) {
  return typeof ts === "number" && Number.isFinite(ts) ? Math.round(ts) : now;
}

// Stores one row unless a cap is reached. Returns 204 (stored or replay) or 429 (cap).
async function store(env, row) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const globalCap = intVar(env.DAILY_CAP, 2000);
  const visitorCap = intVar(env.VISITOR_CAP, 60);
  const g = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE day = ?").bind(day).first();
  if (((g && g.n) || 0) >= globalCap) return 429;
  const v = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE day = ? AND visitor = ?")
    .bind(day, row.visitor)
    .first();
  if (((v && v.n) || 0) >= visitorCap) return 429;
  // INSERT OR IGNORE on the primary key = replay protection by event id.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO events (id, experiment, visitor, type, kind, source, payload, success, ts, day, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      row.id, row.experiment, row.visitor, row.type, row.kind || null, row.source || null,
      row.payload || null, row.success ? 1 : 0, cleanTs(row.ts, now), day, now
    )
    .run();
  return 204;
}

async function handleEvent(req, env) {
  const body = await readJson(req);
  checkCommon(body, env);
  if (typeof body.type !== "string" || !WORD_RE.test(body.type)) throw new HttpError(400, "invalid type");
  if (body.source != null && !(typeof body.source === "string" && SOURCE_RE.test(body.source))) {
    throw new HttpError(400, "invalid source");
  }
  const ts = cleanTs(body.ts, Date.now());
  let id = body.id;
  if (id == null) id = `${body.visitor}:${body.type}:${ts}`;
  if (typeof id !== "string" || !EVENT_ID_RE.test(id)) throw new HttpError(400, "invalid id");
  return store(env, {
    id, experiment: body.experiment, visitor: body.visitor, type: body.type,
    source: body.source, ts,
  });
}

async function handleAction(req, env, forcedKind) {
  const body = await readJson(req);
  checkCommon(body, env);
  const kind = forcedKind || body.kind;
  if (typeof kind !== "string" || !WORD_RE.test(kind)) throw new HttpError(400, "invalid kind");
  if (typeof body.id !== "string" || !EVENT_ID_RE.test(body.id)) throw new HttpError(400, "invalid id");
  const payload = body.payload == null ? {} : body.payload;
  if (typeof payload !== "object" || Array.isArray(payload)) throw new HttpError(400, "invalid payload");
  let success = false;
  if (!forcedKind) {
    const declared = successKinds(env)[body.experiment];
    success = !!declared && payload.kind === declared;
    if (success && declared === "use_case") success = wordCount(payload.text) >= 50;
  }
  return store(env, {
    id: body.id, experiment: body.experiment, visitor: body.visitor,
    type: forcedKind ? "interview" : "action", kind, payload: JSON.stringify(payload),
    success, ts: body.ts,
  });
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleExport(url, env, headers) {
  const key = url.searchParams.get("key");
  if (!env.EXPORT_KEY || !safeEqual(key, String(env.EXPORT_KEY))) {
    return reply(403, headers, { error: "forbidden" });
  }
  const res = await env.DB.prepare(
    "SELECT experiment, visitor, type, source, success, ts FROM events ORDER BY ts ASC"
  ).all();
  const out = {};
  for (const e of list(env.EXPERIMENTS)) {
    out[e] = { qualified_visits: 0, primary_successes: 0, by_source: {}, first_event: null };
  }
  const visits = {};
  const qualified = {};
  for (const r of res.results || []) {
    const o = out[r.experiment];
    if (!o) continue;
    if (o.first_event === null || r.ts < o.first_event) o.first_event = r.ts;
    if (r.success) o.primary_successes += 1;
    const vk = r.experiment + "|" + r.visitor;
    if (r.type === "visit" && !(vk in visits)) visits[vk] = r.source || "direct";
    if (r.type === "view" && vk in visits && !qualified[vk]) {
      qualified[vk] = true;
      o.qualified_visits += 1;
      o.by_source[visits[vk]] = (o.by_source[visits[vk]] || 0) + 1;
    }
  }
  return reply(200, headers, out);
}

async function route(req, env) {
  const url = new URL(req.url);
  const headers = corsHeaders(req, env);
  const path = url.pathname;
  const method = req.method;
  if (method === "OPTIONS") {
    checkOrigin(req, env);
    return reply(204, headers);
  }
  if (method === "GET" && path === "/health") return reply(200, headers, { ok: true });
  if (method === "GET" && path === "/export") return handleExport(url, env, headers);
  if (method === "POST" && (path === "/e" || path === "/action" || path === "/interview")) {
    checkOrigin(req, env);
    let status;
    if (path === "/e") status = await handleEvent(req, env);
    else if (path === "/action") status = await handleAction(req, env, null);
    else status = await handleAction(req, env, "interview");
    if (status === 429) return reply(429, headers, { error: "daily cap reached" });
    return reply(204, headers);
  }
  if (method === "DELETE" && path.startsWith("/visitor/")) {
    checkOrigin(req, env);
    const id = decodeURIComponent(path.slice("/visitor/".length));
    if (!VISITOR_RE.test(id)) throw new HttpError(400, "invalid visitor");
    await env.DB.prepare("DELETE FROM events WHERE visitor = ?").bind(id).run();
    return reply(204, headers);
  }
  throw new HttpError(404, "not found");
}

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      const headers = corsHeaders(req, env);
      if (e instanceof HttpError) return reply(e.status, headers, { error: e.message });
      return reply(500, headers, { error: "internal error" });
    }
  },
  async scheduled(evt, env) {
    await env.DB.prepare("DELETE FROM events WHERE created < ?").bind(Date.now() - RETENTION_MS).run();
  },
};
