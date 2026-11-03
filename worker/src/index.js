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
