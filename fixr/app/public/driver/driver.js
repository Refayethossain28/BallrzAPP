// Fixr driver PWA — talks to the same REST API as the operator console.
// Real browser geolocation pings the server; status buttons drive the same
// lifecycle endpoints dispatch uses.
const $ = (id) => document.getElementById(id);
const api = (p, opts) => fetch(p, { headers: { "Content-Type": "application/json" }, ...opts })
  .then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.error || r.statusText); return b; });

// Driver identity comes from the link the dispatcher sends (?d=driverId).
const params = new URLSearchParams(location.search);
const DRIVER_ID = params.get("d") || "d1";
let watchId = null;

async function load() {
  try {
    const { driver, trips } = await api(`/api/driver/${DRIVER_ID}/trips`);
    $("who").textContent = `${driver.name} · ${driver.vehicle || ""}`;
    renderTrips(trips);
    const status = await api(`/api/drivers/${DRIVER_ID}/connect/status`);
    $("onboard").style.display = status.connected ? "none" : "block";
  } catch (e) { $("trips").innerHTML = `<div class="empty">${e.message}</div>`; }
}

function renderTrips(trips) {
  if (!trips.length) { $("trips").innerHTML = `<div class="empty">No active trips.<br>You'll see assignments here.</div>`; return; }
  $("trips").innerHTML = trips.map(tripCard).join("");
  trips.forEach((t) => {
    const card = document.querySelector(`[data-id="${t.id}"]`);
    card.querySelectorAll("button[data-act]").forEach((b) => (b.onclick = () => act(b.dataset.act, t.id)));
    if (t.type === "airport" && t.parsed_payload.flight) loadFlight(t);
  });
}

function tripCard(t) {
  const p = t.parsed_payload || {};
  const route = t.type === "concierge" ? (p.venue || "Concierge")
    : [p.pickup, p.dropoff].filter(Boolean).join(" → ") || p.dropoff || "Point to point";
  const r = (k, v) => v ? `<div class="row"><span>${k}</span><b>${v}</b></div>` : "";
  return `<div class="trip ${t.type === "airport" ? "airport" : ""}" data-id="${t.id}">
    <div class="top"><span class="who">${t.client_name}</span>
      <span class="pill ${t.status}">${t.status === "in_progress" ? "EN ROUTE" : "ASSIGNED"}</span></div>
    <div class="badge">${t.type}</div>
    ${r("Pickup", p.datetime)}${r("Route", route)}${r("Vehicle", p.vehicle)}${r("Pax", p.pax)}
    ${p.flight ? `<div class="flight" id="fl-${t.id}">✈ ${p.flight} · checking…</div>` : ""}
    <div class="row"><span>Fare</span><b class="pay">${t.quote_amount ? "$" + t.quote_amount : "—"}</b></div>
    <div class="actions">
      ${t.status === "assigned" ? `<button class="btn" data-act="enroute">Start trip (en route)</button>` : ""}
      ${t.status === "in_progress" ? `<button class="btn" data-act="complete">Complete trip</button>` : ""}
      ${p.dropoff ? `<button class="btn-ghost" data-act="nav" style="flex:0 0 auto;width:auto">🧭 Navigate</button>` : ""}
    </div></div>`;
}

async function loadFlight(t) {
  try {
    const s = await api(`/api/flight/${t.parsed_payload.flight}`);
    const el = $(`fl-${t.id}`); if (!el) return;
    const late = s.delayMinutes > 0;
    el.innerHTML = `✈ ${s.flight} · <b style="color:${late ? "var(--amber)" : "var(--green)"}">${s.status}</b>`
      + (s.gate ? ` · gate ${s.gate}` : "") + (late ? ` · +${s.delayMinutes}m` : "");
  } catch {}
}

async function act(a, id) {
  const p = (await api(`/api/driver/${DRIVER_ID}/trips`)).trips.find((t) => t.id === id);
  if (a === "nav") {
    const dest = encodeURIComponent(p?.parsed_payload?.dropoff || "");
    return window.open(`https://maps.google.com/?q=${dest}`, "_blank");
  }
  try { await api(`/api/driver/${DRIVER_ID}/trips/${id}/${a}`, { method: "POST" }); await load(); }
  catch (e) { alert(e.message); }
}

// Real geolocation: watch position, ping the server. (Background GPS needs a
// native shell — see DRIVER-APP.md; this foreground watch works on any phone.)
$("gps-btn").onclick = () => {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; setGps(false); return; }
  if (!navigator.geolocation) return alert("Geolocation not available");
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      setGps(true);
      api(`/api/driver/${DRIVER_ID}/location`, {
        method: "POST",
        body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      }).catch(() => {});
    },
    (err) => { setGps(false); alert("Location error: " + err.message); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
};
function setGps(on) {
  $("gpsdot").className = "dot" + (on ? " on" : "");
  $("gpslabel").textContent = on ? "Sharing live" : "GPS off";
  $("gps-btn").textContent = on ? "⏹ Stop sharing location" : "📍 Start sharing location";
}

$("onboard-btn").onclick = async () => {
  const link = await api(`/api/drivers/${DRIVER_ID}/connect/onboard`, { method: "POST" });
  location.href = link.url; // hosted Stripe onboarding (or mock return)
};

load();
// Live updates via SSE (new assignments appear instantly); polling stays as fallback.
try {
  const es = new EventSource("/api/events");
  let esT;
  es.onmessage = () => { clearTimeout(esT); esT = setTimeout(load, 200); };
} catch {}
setInterval(load, 30000); // fallback poll
