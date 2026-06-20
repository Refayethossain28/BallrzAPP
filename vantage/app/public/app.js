// Vantage operator console — talks to the real REST API in server.js.
const $ = (id) => document.getElementById(id);
const api = (p, opts) => fetch(p, { headers: { "Content-Type": "application/json" }, ...opts }).then((r) => {
  if (!r.ok) return r.json().then((e) => Promise.reject(new Error(e.error || r.statusText)));
  return r.json();
});

const STAGES = ["quoted", "confirmed", "assigned", "in_progress", "completed"];
const STAGE_LABEL = { quoted: "Quoted", confirmed: "Confirmed", assigned: "Assigned", in_progress: "En route", completed: "Completed" };
const SAMPLES = [
  { label: "✈ JFK airport run", text: "Need a Suburban to JFK Thursday 6am for Mr. Alvarez, 2 passengers 3 bags, flight DL472" },
  { label: "⏱ Hourly / as-directed", text: "S-Class for Mrs. Lin tomorrow 7pm, as directed about 4 hours, dinner then theater downtown" },
  { label: "🚘 Point to point", text: "Sedan from The Peninsula to 432 Park Ave at 9:15am, just one passenger" },
  { label: "🍽 Concierge (Phase 3)", text: "Can you get Mr. Alvarez a table for 4 at Carbone Friday 8pm, quiet corner booth" },
];

let draft = null;
let requests = [];
let drivers = [];

async function refresh() {
  [requests, drivers] = await Promise.all([api("/api/requests"), api("/api/resources")]);
  render();
}

async function boot() {
  $("samples").innerHTML = SAMPLES.map((s, i) => `<span class="chip" data-i="${i}">${s.label}</span>`).join("");
  $("samples").onclick = (e) => { const i = e.target.dataset.i; if (i != null) { $("inbound").value = SAMPLES[i].text; doParse(); } };
  $("parse-btn").onclick = doParse;
  $("confirm-btn").onclick = doConfirm;
  $("modal-bg").onclick = (e) => { if (e.target === $("modal-bg")) closeModal(); };
  try {
    const h = await api("/api/health");
    $("s-mode").textContent = h.intake === "llm" ? "Claude" : "Heuristic";
    $("foot").innerHTML += ` &middot; live mode: intake=<code>${h.intake}</code> payments=<code>${h.payments}</code>`;
  } catch {}
  await refresh();
}

async function doParse() {
  const text = $("inbound").value.trim();
  if (!text) return $("inbound").focus();
  const btn = $("parse-btn");
  btn.disabled = true; btn.textContent = "⚡ Parsing…";
  try {
    const { parsed, quote } = await api("/api/parse", { method: "POST", body: JSON.stringify({ text }) });
    draft = { parsed, quote };
    renderDraft();
  } catch (e) { alert("Parse failed: " + e.message); }
  finally { btn.disabled = false; btn.textContent = "⚡ Parse into a booking"; }
}

function renderDraft() {
  const { parsed: p, quote } = draft;
  $("intake-type").textContent = p.type + (p._engine ? " · " + p._engine : "");
  $("intake-type").className = "typetag t-" + p.type;
  const row = (k, v) => v ? `<div class="field"><span>${k}</span><b>${v}</b></div>` : "";
  $("fields").innerHTML =
    row("Client", p.client) +
    (p.type === "concierge"
      ? row("Venue", p.venue || "—") + row("Party size", p.pax) + row("When", p.datetime)
      : row("When", p.datetime) +
        row("Route", [p.pickup, p.dropoff].filter(Boolean).join("  →  ") || "—") +
        row("Vehicle", p.vehicle) + row("Passengers", p.pax) +
        (p.flight ? row("Flight (auto-tracked)", p.flight) : "") +
        (p.hours ? row("Hours", p.hours) : ""));
  const q = $("quote");
  q.style.display = "block";
  q.innerHTML = quote
    ? quote.lines.map((l) => `<div class="line"><span>${l[0]}</span><span>$${l[1]}</span></div>`).join("") +
      `<div class="total"><span>Instant quote</span><span>$${quote.total}</span></div>`
    : `<div class="line"><span>Concierge — service fee set on confirm</span></div><div class="total"><span>Type</span><span>Concierge</span></div>`;
  $("parsed").style.display = "block";
}

async function doConfirm() {
  if (!draft) return;
  await api("/api/requests", { method: "POST", body: JSON.stringify({ parsed: draft.parsed, source: "intake" }) });
  draft = null;
  $("parsed").style.display = "none";
  $("inbound").value = "";
  $("intake-type").textContent = "—"; $("intake-type").className = "typetag t-transfer";
  await refresh();
}

function render() {
  $("lanes").innerHTML = STAGES.map((st) => {
    const items = requests.filter((r) => r.status === st);
    return `<div class="lane"><h3>${STAGE_LABEL[st]} <i>${items.length}</i></h3>${items.map(reqCard).join("")}</div>`;
  }).join("");
  document.querySelectorAll(".req").forEach((el) => (el.onclick = () => openReq(el.dataset.id)));

  $("drivers").innerHTML = drivers.map((d) => `
    <div class="driver"><div class="av">${initials(d.name)}</div>
      <div class="meta"><b>${d.name}</b><span>${d.vehicle || ""}</span></div>
      <span class="pill ${d.status === "available" ? "p-av" : "p-on"}">${d.status === "available" ? "Available" : "On trip"}</span></div>`).join("");

  $("s-open").textContent = requests.filter((r) => r.status !== "completed").length;
  $("s-rev").textContent = "$" + requests.reduce((s, r) => s + (r.quote_amount || 0), 0).toLocaleString();
  renderAudit();
}

function reqCard(r) {
  const p = r.parsed_payload || {};
  const sub = r.type === "concierge" ? (p.venue || "Concierge request")
    : r.type === "airport" ? ((p.dropoff || "Airport") + (p.flight ? " · " + p.flight : ""))
    : [p.pickup, p.dropoff].filter(Boolean).join(" → ") || "Point to point";
  const mins = minsToSla(r.sla_due_at);
  const slaCls = mins == null ? "ok" : mins > 30 ? "ok" : mins > 12 ? "warn" : "late";
  const driver = drivers.find((d) => d.id === r.assigned_resource_id);
  return `<div class="req ${r.type === "concierge" ? "concierge" : ""}" data-id="${r.id}">
    <div class="top"><span class="who">${r.client_name}</span><span class="typetag t-${r.type}">${r.type}</span></div>
    <div class="rt">${sub}</div>
    <div class="top" style="margin:6px 0 0">
      <span class="amt">${r.quote_amount ? "$" + r.quote_amount : "—"}</span>
      <span class="sla"><span class="dot ${slaCls}"></span>${driver ? driver.name.split(" ")[0] : mins == null ? "—" : "pickup in " + mins + "m"}</span>
    </div></div>`;
}

function openReq(id) {
  const r = requests.find((x) => x.id === id); if (!r) return;
  const p = r.parsed_payload || {};
  const avail = drivers.filter((d) => d.status === "available");
  $("m-title").textContent = `${r.client_name} · ${r.type}`;
  const f = (k, v) => v ? `<div class="field"><span>${k}</span><b>${v}</b></div>` : "";
  $("m-body").innerHTML = `
    ${f("Stage", STAGE_LABEL[r.status])}${f("When", p.datetime)}
    ${r.type !== "concierge" ? f("Route", [p.pickup, p.dropoff].filter(Boolean).join(" → ") || p.dropoff) + f("Vehicle", p.vehicle) : f("Venue", p.venue)}
    ${p.flight ? `<div class="field"><span>Flight</span><b id="flightline">checking…</b></div>` : ""}
    ${f("Quote", r.quote_amount ? "$" + r.quote_amount : "set fee")}
    <div class="field"><span>Original message</span></div>
    <div class="raw">“${r.raw_inbound_text || ""}”</div>
    ${(r.status === "confirmed" || r.status === "quoted") && avail.length
      ? `<div style="margin-top:14px"><span style="color:var(--muted);font-size:12px">Assign resource</span>
         <select id="assignSel">${avail.map((d) => `<option value="${d.id}">${d.name} — ${d.vehicle}</option>`).join("")}</select></div>` : ""}
    <div class="actions">
      ${r.status === "quoted" ? `<button class="btn-gold" data-act="confirm">Mark client confirmed</button>` : ""}
      ${r.status === "confirmed" && avail.length ? `<button class="btn-gold" data-act="assign">Assign &amp; dispatch</button>` : ""}
      ${r.status === "assigned" ? `<button class="btn-gold" data-act="enroute">Driver en route</button>` : ""}
      ${r.status === "in_progress" ? `<button class="btn-gold" data-act="complete">Complete &amp; capture payment</button>` : ""}
      <button class="btn-ghost" data-act="close">Close</button>
    </div>
    ${r.status === "completed" ? '<div class="note">Completed — payment captured. Phase 1.5 settles the driver payout via Stripe Connect.</div>' : ""}`;
  $("m-body").onclick = (e) => act(e.target.dataset.act, r.id);
  $("modal-bg").style.display = "grid";

  // Live flight status for airport pickups.
  if (r.type === "airport" && p.flight) {
    api(`/api/flight/${p.flight}`).then((s) => {
      const el = document.getElementById("flightline");
      if (!el) return;
      const late = s.delayMinutes > 0;
      el.innerHTML = `<b>${s.flight}</b> · <span style="color:${late ? "var(--amber)" : "var(--green)"}">${s.status}</span>`
        + (s.gate ? ` · gate ${s.gate}` : "")
        + (late ? ` · +${s.delayMinutes}m, pickup auto-adjusted` : "")
        + ` <span style="color:var(--muted)">(${s.source})</span>`;
    }).catch(() => {});
  }
}

async function act(a, id) {
  if (!a) return;
  if (a === "close") return closeModal();
  try {
    if (a === "assign") {
      const sel = document.getElementById("assignSel");
      await api(`/api/requests/${id}/assign`, { method: "POST", body: JSON.stringify({ resource_id: sel.value }) });
    } else if (a === "complete") {
      const { payment: pay } = await api(`/api/requests/${id}/complete`, { method: "POST" });
      if (pay.driverShare) alert(`Fare captured.\nDriver settled: $${pay.driverShare}\nPlatform fee: $${pay.platformFee}\nOperator net: $${pay.operatorNet}`);
    } else {
      await api(`/api/requests/${id}/${a === "confirm" ? "confirm" : a}`, { method: "POST" });
    }
    await refresh();
    openReq(id);
  } catch (e) { alert(e.message); }
}

function closeModal() { $("modal-bg").style.display = "none"; }

function renderAudit() {
  const all = [];
  for (const r of requests) for (const e of (r.audit_log || [])) all.push({ who: r.client_name, ...e });
  all.sort((a, b) => (a.t < b.t ? 1 : -1));
  $("audit").innerHTML = all.slice(0, 40).map((e) =>
    `<div class="e"><time>${fmt(e.t)}</time><div class="a"><em>${e.who}</em> · ${e.action}</div></div>`).join("")
    || '<div class="note">No activity yet — parse a sample on the left.</div>';
}

const initials = (n) => n.split(" ").map((x) => x[0]).join("");
const fmt = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
const minsToSla = (iso) => iso ? Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000)) : null;

boot();
