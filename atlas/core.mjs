/**
 * Atlas — pure, deterministic core for the LAN node registry + scheduler.
 *
 * Everything here is a pure function: no clocks, no sockets, no `os` calls. The
 * caller passes `now` (ms epoch) explicitly, so the registry, the scheduler and
 * the unit tests all exercise the same code with reproducible results. The
 * network plumbing lives in registry.mjs / agent.mjs; the *decisions* live here.
 *
 * Design rule for the MVP (from the spec): "Do not make it smart yet. Make it
 * visible and reliable first." So node selection is a plain, explainable filter
 * + sort — capability match, then health, then lowest load — not a clever cost
 * model. Every rejection carries a human-readable reason so the dashboard and
 * the API can always say *why* a node was or wasn't picked.
 *
 * Zero dependencies — Node/ESM only.
 */

/** Canonical capability + service names are lower-cased, trimmed strings. */
export function normList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const item of v) {
    if (item == null) continue;
    const s = String(item).trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.sort();
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Normalise a raw Node-Agent report into a canonical node record. Unknown /
 * malformed fields are coerced to safe defaults rather than thrown away, so a
 * slightly-wrong agent still shows up on the dashboard (visible > silent).
 * `receivedAt` is stamped by the registry when the report lands.
 */
export function normalizeReport(raw, receivedAt) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const hostname = String(r.hostname || '').trim() || 'unknown';
  const id = String(r.id || r.hostname || '').trim() || hostname;
  return {
    id,
    hostname,
    ip: String(r.ip || '').trim(),
    cpuCores: Math.max(0, Math.round(num(r.cpuCores))),
    ramMB: Math.max(0, Math.round(num(r.ramMB))),
    gpuName: String(r.gpuName || '').trim(),
    vramMB: Math.max(0, Math.round(num(r.vramMB))),
    services: normList(r.services),
    capabilities: normList(r.capabilities),
    load: clamp01(r.load),
    // Reported health from the agent's own self-check: ok | degraded | down.
    reportedHealth: normHealth(r.health),
    lastSeen: num(receivedAt, num(r.lastSeen)),
  };
}

/** Coerce a reported health string to one of ok | degraded | down. */
export function normHealth(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'degraded' || s === 'warn' || s === 'warning') return 'degraded';
  if (s === 'down' || s === 'unhealthy' || s === 'dead' || s === 'error') return 'down';
  return 'ok';
}

/**
 * Effective status of a node right now, combining liveness (did we hear from it
 * recently?) with its self-reported health. A node we haven't heard from within
 * `staleAfterMs` is `stale` regardless of what it last claimed.
 *
 *   healthy   — fresh heartbeat, reported ok        → schedulable
 *   degraded  — fresh heartbeat, reported degraded  → not scheduled (visible)
 *   unhealthy — fresh heartbeat, reported down       → not scheduled
 *   stale     — no heartbeat within the window       → not scheduled
 */
export function nodeStatus(node, now, staleAfterMs = 15000) {
  if (!node) return 'stale';
  const age = num(now) - num(node.lastSeen);
  if (age > num(staleAfterMs, 15000)) return 'stale';
  switch (node.reportedHealth) {
    case 'down': return 'unhealthy';
    case 'degraded': return 'degraded';
    default: return 'healthy';
  }
}

/** True only when the node is safe to route work to. Conservative by design. */
export function isSchedulable(node, now, staleAfterMs = 15000) {
  return nodeStatus(node, now, staleAfterMs) === 'healthy';
}

/** Does the node advertise every capability the task requires? */
export function hasCapabilities(node, required) {
  const need = normList(required);
  if (need.length === 0) return true;
  const have = new Set(node && Array.isArray(node.capabilities) ? node.capabilities : []);
  return need.every((c) => have.has(c));
}

/**
 * Deterministic ordering of two candidate nodes — the "best" one sorts first.
 * Intentionally simple and explainable: least loaded wins; ties broken by more
 * CPU, then more RAM, then more VRAM, then id (so the result is stable).
 */
export function compareNodes(a, b) {
  if (a.load !== b.load) return a.load - b.load;          // lower load first
  if (a.cpuCores !== b.cpuCores) return b.cpuCores - a.cpuCores;
  if (a.ramMB !== b.ramMB) return b.ramMB - a.ramMB;
  if (a.vramMB !== b.vramMB) return b.vramMB - a.vramMB;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Pick the best node for a task request. Returns a decision object that is
 * *always* explainable:
 *
 *   { node, reason, candidates }         — a node was chosen
 *   { node: null, reason, candidates: [] } — nothing eligible, with the reason
 *
 * `request` = { capabilities?: string[] }. `now`/`staleAfterMs` gate liveness.
 * No side effects — the registry does the dispatch.
 */
export function selectNode(nodes, request, now, staleAfterMs = 15000) {
  const list = Array.isArray(nodes) ? nodes : [];
  const required = normList(request && request.capabilities);

  if (list.length === 0) {
    return { node: null, reason: 'no nodes registered', required, candidates: [] };
  }

  const live = list.filter((n) => isSchedulable(n, now, staleAfterMs));
  if (live.length === 0) {
    return { node: null, reason: 'no healthy nodes (all stale/degraded/down)', required, candidates: [] };
  }

  const capable = live.filter((n) => hasCapabilities(n, required));
  if (capable.length === 0) {
    return {
      node: null,
      reason: `no healthy node has all required capabilities [${required.join(', ')}]`,
      required,
      candidates: [],
    };
  }

  const ranked = capable.slice().sort(compareNodes);
  const chosen = ranked[0];
  return {
    node: chosen,
    reason: required.length
      ? `matched [${required.join(', ')}], lowest load (${chosen.load})`
      : `lowest load (${chosen.load})`,
    required,
    candidates: ranked.map((n) => n.id),
  };
}

/** Roll up counts for the dashboard header. Pure. */
export function summarize(nodes, now, staleAfterMs = 15000) {
  const list = Array.isArray(nodes) ? nodes : [];
  const tally = { total: list.length, healthy: 0, degraded: 0, unhealthy: 0, stale: 0 };
  const caps = new Set();
  for (const n of list) {
    tally[nodeStatus(n, now, staleAfterMs)]++;
    for (const c of n.capabilities || []) caps.add(c);
  }
  return { ...tally, capabilities: [...caps].sort() };
}
