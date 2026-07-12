// Fixr passenger app — book a car and track it. Same REST API + `request`
// primitive as dispatch and the driver app; here the guest creates the request.
const $ = (id) => document.getElementById(id);
const api = (p, opts) => fetch(p, { headers: { "Content-Type": "application/json" }, ...opts })
  .then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.error || r.statusText); return b; });

const STEPS = ["quoted", "confirmed", "assigned", "in_progress", "completed"];
const LABEL = { quoted: "Request received", confirmed: "Confirmed", assigned: "Driver assigned", in_progress: "On the way", completed: "Completed" };
let pollTimer = null;
let trackedId = null;

function form() {
  return {
    pickup: $("pickup").value.trim(), dropoff: $("dropoff").value.trim(),
    when: $("when").value.trim(), pax: $("pax").value || 1,
    vehicle: $("vehicle").value, flight: $("flight").value.trim(), client_name: $("name").value.trim(),
  };
}

$("quote-btn").onclick = async () => {
  $("err").textContent = "";
  const f = form();
  if (!f.pickup || !f.dropoff) return ($("err").textContent = "Enter pickup and drop-off.");
  // Preview the quote by creating nothing yet — ask the parse/quote via a throwaway parse.
  try {
    const { parsed, quote } = await api("/api/parse", {
      method: "POST",
      body: JSON.stringify({ text: `${f.vehicle} from ${f.pickup} to ${f.dropoff} ${f.when} ${f.flight ? "flight " + f.flight : ""} ${f.pax} passengers` }),
    });
    const q = quote || { lines: [], total: 0 };
    $("quote").style.display = "block";
    $("quote").innerHTML = q.lines.map((l) => `<div class="row"><span>${l[0]}</span><span>$${l[1]}</span></div>`).join("")
      + `<div class="total"><span>Your fare</span><span>$${q.total}</span></div>`;
    $("book-btn").style.display = "block";
  } catch (e) { $("err").textContent = e.message; }
};

$("book-btn").onclick = async () => {
  $("err").textContent = "";
  try {
    const { request } = await api("/api/client/request", { method: "POST", body: JSON.stringify(form()) });
    saveTrip(request.id);
    openTracking(request.id);
  } catch (e) { $("err").textContent = e.message; }
};

// Mode tabs: ride vs concierge.
$("tab-ride").onclick = () => setMode("ride");
$("tab-conc").onclick = () => setMode("conc");
function setMode(m) {
  $("err").textContent = "";
  $("tab-ride").classList.toggle("on", m === "ride");
  $("tab-conc").classList.toggle("on", m === "conc");
  $("ride-form").style.display = m === "ride" ? "block" : "none";
  $("conc-form").style.display = m === "conc" ? "block" : "none";
}

$("conc-btn").onclick = async () => {
  $("err").textContent = "";
  const request = $("c-request").value.trim();
  if (!request) return ($("err").textContent = "Tell us what you'd like arranged.");
  try {
    const { request: r } = await api("/api/client/concierge", {
      method: "POST",
      body: JSON.stringify({ request, when: $("c-when").value.trim(), client_name: $("c-name").value.trim() }),
    });
    saveTrip(r.id);
    openTracking(r.id);
  } catch (e) { $("err").textContent = e.message; }
};

$("back-btn").onclick = () => { clearInterval(pollTimer); show("book"); renderTrips(); };

async function openTracking(id) {
  trackedId = id;
  show("track");
  await refreshTrack(id);
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refreshTrack(id), 8000);
}

async function refreshTrack(id) {
  try {
    const t = await api(`/api/client/request/${id}`);
    const concierge = t.type === "concierge";
    $("t-status").textContent = LABEL[t.status] || t.status;
    const idx = STEPS.indexOf(t.status);
    $("t-steps").innerHTML = STEPS.map((_, i) => `<div class="step ${i <= idx ? "on" : ""}"></div>`).join("");
    $("t-kind").textContent = concierge ? "Your request" : "Your ride";
    $("row-to").style.display = concierge ? "none" : "flex";
    $("row-vehicle").style.display = concierge ? "none" : "flex";
    $("lbl-from").textContent = concierge ? "Request" : "From";
    $("t-from").textContent = concierge ? (t.request || t.venue) : t.pickup;
    $("t-to").textContent = t.dropoff;
    $("t-when").textContent = t.when; $("t-vehicle").textContent = t.vehicle;
    $("lbl-fare").textContent = concierge ? "Service fee" : "Fare";
    $("t-fare").textContent = t.quote ? "$" + t.quote : (concierge ? "pending" : "—");
    const d = $("t-driver");
    if (t.driver) {
      d.style.display = "flex";
      d.innerHTML = `<div class="av">${t.driver.name.split(" ").map((x) => x[0]).join("")}</div>
        <div><b>${t.driver.name}</b><div style="color:var(--muted);font-size:13px">${t.driver.vehicle || ""}${t.driver.sharing_location ? " · live location" + agoLabel(t.driver.location_at) : ""}</div></div>`;
    } else d.style.display = "none";
    if (t.status === "completed") clearInterval(pollTimer);
  } catch (e) { $("err").textContent = e.message; }
}

function show(which) {
  $("book").style.display = which === "book" ? "block" : "none";
  $("track").style.display = which === "track" ? "block" : "none";
}

function agoLabel(iso) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  return s < 90 ? ` (updated ${s}s ago)` : ` (updated ${Math.round(s / 60)}m ago)`;
}

/* local trip history */
function saveTrip(id) {
  const t = JSON.parse(localStorage.getItem("fixr_trips") || "[]");
  if (!t.includes(id)) { t.unshift(id); localStorage.setItem("fixr_trips", JSON.stringify(t.slice(0, 10))); }
}
async function renderTrips() {
  const ids = JSON.parse(localStorage.getItem("fixr_trips") || "[]");
  if (!ids.length) { $("trips").innerHTML = ""; return; }
  const rows = await Promise.all(ids.map((id) => api(`/api/client/request/${id}`).catch(() => null)));
  $("trips").innerHTML = `<h3>Your trips</h3>` + rows.filter(Boolean).map((t) => {
    const label = t.type === "concierge" ? (t.request || t.venue || "Concierge") : `${t.pickup} → ${t.dropoff}`;
    return `<div class="trip" data-id="${t.id}"><span>${label}</span><span>${LABEL[t.status] || t.status}</span></div>`;
  }).join("");
  $("trips").querySelectorAll("[data-id]").forEach((el) => (el.onclick = () => openTracking(el.dataset.id)));
}

renderTrips();

// Live updates: refresh the tracked trip the moment anything changes server-side.
try {
  const es = new EventSource("/api/events");
  let esT;
  es.onmessage = () => {
    if (!trackedId) return;
    clearTimeout(esT); esT = setTimeout(() => refreshTrack(trackedId), 200);
  };
} catch {}
