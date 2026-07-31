import { GUIDES, EMERGENCY_NUMBERS, CHECKLISTS, DISCLAIMER } from "./data.js";

const app = document.getElementById("app");

const LS_KEYS = {
  ice: "lifeline.ice.v1",
  checks: "lifeline.checks.v1",
  region: "lifeline.region.v1"
};

// ---------- small utilities ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full/blocked */ }
}

function telHref(number) {
  const clean = number.replace(/[^\d+]/g, "");
  return /^\+?\d{2,6}$/.test(clean) ? `tel:${clean}` : null;
}

function primaryNumber(entry) {
  return entry.all ? entry.all.split("/")[0].trim() : entry.ambulance;
}

const DISCLAIMER_HTML = `<p class="disclaimer">${esc(DISCLAIMER)}</p>`;

// ---------- views ----------

function viewHome() {
  const region = loadJSON(LS_KEYS.region, null);
  const entry = EMERGENCY_NUMBERS.find(e => e.region === region) || null;
  const num = entry ? primaryNumber(entry) : null;
  const href = num ? telHref(num) : null;

  const banner = entry && href
    ? `<a class="call-banner" href="${href}">📞 Call ${esc(num)} now
         <small>${esc(entry.region)} — tap to dial. Change region in the Numbers tab.</small></a>`
    : `<a class="call-banner" href="#/numbers">📞 In an emergency, call for help first
         <small>Tap to find your local emergency number</small></a>`;

  app.innerHTML = `
    ${banner}
    <input type="search" class="search" id="guide-search"
           placeholder="Search: choking, burns, CPR…" autocomplete="off" aria-label="Search guides">
    <div class="guide-grid" id="guide-grid"></div>
    ${DISCLAIMER_HTML}
  `;

  const grid = document.getElementById("guide-grid");
  const search = document.getElementById("guide-search");

  const render = (q = "") => {
    const needle = q.trim().toLowerCase();
    const matches = GUIDES.filter(g =>
      !needle ||
      g.title.toLowerCase().includes(needle) ||
      g.summary.toLowerCase().includes(needle) ||
      g.steps.some(s => s.toLowerCase().includes(needle))
    );
    grid.innerHTML = matches.length
      ? matches.map(g => `
          <a class="guide-card" href="#/guide/${g.id}">
            <span class="g-icon" aria-hidden="true">${g.icon}</span>
            <span class="g-title">${esc(g.title)}</span>
            ${g.urgent ? '<span class="g-tag">life-threatening</span>' : ""}
          </a>`).join("")
      : `<p class="no-results">No guide matches “${esc(q)}”. In doubt? Call your emergency number.</p>`;
  };

  render();
  search.addEventListener("input", () => render(search.value));
}

function viewGuide(id) {
  const g = GUIDES.find(x => x.id === id);
  if (!g) { location.hash = "#/"; return; }

  app.innerHTML = `
    <a class="back-link" href="#/">← All guides</a>
    <div class="guide-head">
      <span class="g-icon" aria-hidden="true">${g.icon}</span>
      <div><h1>${esc(g.title)}</h1><p class="muted" style="margin:0">${esc(g.summary)}</p></div>
    </div>
    ${g.callFirst ? `<p class="call-first">📞 Call your emergency number first — or shout for someone to call while you act.</p>` : ""}
    <ol class="steps">${g.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>
    ${DISCLAIMER_HTML}
  `;
  window.scrollTo(0, 0);
}

function viewNumbers() {
  const saved = loadJSON(LS_KEYS.region, null);

  const rows = EMERGENCY_NUMBERS.map(e => {
    const pills = e.all
      ? [`<span class="num-pill">${esc(e.all)}</span>`]
      : [
          `<a class="num-pill" ${linkAttr(e.ambulance)}>${esc(e.ambulance)} <span>ambulance</span></a>`,
          `<a class="num-pill" ${linkAttr(e.police)}>${esc(e.police)} <span>police</span></a>`,
          `<a class="num-pill" ${linkAttr(e.fire)}>${esc(e.fire)} <span>fire</span></a>`
        ];
    // single-number regions get a dialable pill too when the number is a plain code
    if (e.all) {
      const href = telHref(primaryNumber(e));
      if (href) pills[0] = `<a class="num-pill" href="${href}">${esc(e.all)}</a>`;
    }
    const checked = saved === e.region ? "checked" : "";
    return `
      <label class="num-row">
        <span class="region">
          <input type="radio" name="home-region" value="${esc(e.region)}" ${checked}
                 style="accent-color: var(--red-bright); margin-right:8px">
          ${esc(e.region)}
        </span>
        <span class="nums">${pills.join("")}</span>
      </label>`;
  }).join("");

  app.innerHTML = `
    <h1>Emergency numbers</h1>
    <p class="muted">Tap a number to dial. Select your region to pin a one-tap call button on the Emergency tab.
       Saved on this device only — it keeps working with no signal, but dialing needs a phone network.</p>
    <div class="num-list">${rows}</div>
    ${DISCLAIMER_HTML}
  `;

  app.querySelectorAll('input[name="home-region"]').forEach(radio => {
    radio.addEventListener("change", () => saveJSON(LS_KEYS.region, radio.value));
  });

  function linkAttr(number) {
    const href = telHref(number);
    return href ? `href="${href}"` : "";
  }
}

function viewPrepare() {
  const state = loadJSON(LS_KEYS.checks, {});

  app.innerHTML = `
    <h1>Be ready before it happens</h1>
    <p class="muted">Most disasters give no warning. Tick items off as you gather them — progress is saved on this device.</p>
    <div id="checklists"></div>
    ${DISCLAIMER_HTML}
  `;

  const wrap = document.getElementById("checklists");

  const render = () => {
    wrap.innerHTML = CHECKLISTS.map(cl => {
      const done = cl.items.filter((_, i) => state[`${cl.id}:${i}`]).length;
      const pct = Math.round((done / cl.items.length) * 100);
      return `
        <section class="checklist" data-id="${cl.id}">
          <h2><span aria-hidden="true">${cl.icon}</span> ${esc(cl.title)}</h2>
          <p class="muted" style="margin:2px 0 8px">${esc(cl.blurb)}</p>
          <div class="progress">${done} of ${cl.items.length} ready (${pct}%)</div>
          <div class="bar"><div style="width:${pct}%"></div></div>
          ${cl.items.map((item, i) => {
            const key = `${cl.id}:${i}`;
            const checked = state[key] ? "checked" : "";
            return `
              <label class="check-item ${checked ? "done" : ""}">
                <input type="checkbox" data-key="${key}" ${checked}>
                <span>${esc(item)}</span>
              </label>`;
          }).join("")}
        </section>`;
    }).join("");

    wrap.querySelectorAll("input[type=checkbox]").forEach(box => {
      box.addEventListener("change", () => {
        state[box.dataset.key] = box.checked;
        if (!box.checked) delete state[box.dataset.key];
        saveJSON(LS_KEYS.checks, state);
        render();
      });
    });
  };

  render();
}

const ICE_FIELDS = [
  { key: "name", label: "Full name", type: "input" },
  { key: "dob", label: "Date of birth", type: "input" },
  { key: "blood", label: "Blood type", type: "input", placeholder: "e.g. O+" },
  { key: "allergies", label: "Allergies", type: "textarea", placeholder: "Medications, foods, stings…" },
  { key: "conditions", label: "Medical conditions", type: "textarea", placeholder: "Diabetes, epilepsy, pacemaker…" },
  { key: "medications", label: "Current medications", type: "textarea" },
  { key: "contact1", label: "Emergency contact 1 (name & phone)", type: "input" },
  { key: "contact2", label: "Emergency contact 2 (name & phone)", type: "input" },
  { key: "notes", label: "Anything else responders should know", type: "textarea", placeholder: "Organ donor, language, doctor’s name…" }
];

function viewIce(editing = false) {
  const data = loadJSON(LS_KEYS.ice, null);

  if (data && !editing) {
    const rows = ICE_FIELDS
      .filter(f => data[f.key])
      .map(f => `<dt>${esc(f.label)}</dt><dd>${esc(data[f.key])}</dd>`)
      .join("");
    app.innerHTML = `
      <h1>In Case of Emergency</h1>
      <p class="muted">Show this screen to first responders. Set your phone's lock-screen medical ID too.</p>
      <div class="ice-view">
        <h2>🪪 Medical ID</h2>
        <dl>${rows || "<dd>No details filled in yet.</dd>"}</dl>
      </div>
      <div class="ice-actions">
        <button class="btn" id="ice-edit">Edit</button>
        <button class="btn secondary" id="ice-print">Print / save as PDF</button>
        <button class="btn secondary" id="ice-clear">Delete card</button>
      </div>
      <p class="privacy-note">🔒 Stored only in this browser on this device. Lifeline has no server and sends nothing anywhere.</p>
    `;
    document.getElementById("ice-edit").addEventListener("click", () => viewIce(true));
    document.getElementById("ice-print").addEventListener("click", () => window.print());
    document.getElementById("ice-clear").addEventListener("click", () => {
      if (confirm("Delete your medical ID card from this device?")) {
        localStorage.removeItem(LS_KEYS.ice);
        viewIce();
      }
    });
    return;
  }

  const values = data || {};
  app.innerHTML = `
    <h1>In Case of Emergency</h1>
    <p class="muted">A medical ID responders can read in seconds. Everything stays on this device.</p>
    <form class="ice-form" id="ice-form">
      ${ICE_FIELDS.map(f => `
        <label>${esc(f.label)}
          ${f.type === "textarea"
            ? `<textarea name="${f.key}" rows="2" placeholder="${esc(f.placeholder || "")}">${esc(values[f.key] || "")}</textarea>`
            : `<input name="${f.key}" value="${esc(values[f.key] || "")}" placeholder="${esc(f.placeholder || "")}">`}
        </label>`).join("")}
      <div class="ice-actions">
        <button class="btn" type="submit">Save card</button>
        ${data ? '<button class="btn secondary" type="button" id="ice-cancel">Cancel</button>' : ""}
      </div>
    </form>
    <p class="privacy-note">🔒 Stored only in this browser on this device. Lifeline has no server and sends nothing anywhere.</p>
  `;

  document.getElementById("ice-form").addEventListener("submit", e => {
    e.preventDefault();
    const out = {};
    for (const f of ICE_FIELDS) {
      const v = e.target.elements[f.key].value.trim();
      if (v) out[f.key] = v;
    }
    saveJSON(LS_KEYS.ice, out);
    viewIce();
  });
  const cancel = document.getElementById("ice-cancel");
  if (cancel) cancel.addEventListener("click", () => viewIce());
}

// ---------- router ----------

const ROUTES = [
  { match: /^#?\/?$/, tab: "home", render: () => viewHome() },
  { match: /^#\/guide\/([\w-]+)$/, tab: "home", render: m => viewGuide(m[1]) },
  { match: /^#\/numbers$/, tab: "numbers", render: () => viewNumbers() },
  { match: /^#\/prepare$/, tab: "prepare", render: () => viewPrepare() },
  { match: /^#\/ice$/, tab: "ice", render: () => viewIce() }
];

function route() {
  const hash = location.hash || "#/";
  const found = ROUTES.find(r => r.match.test(hash));
  const r = found || ROUTES[0];
  const m = hash.match(r.match);
  r.render(m);
  document.querySelectorAll(".tabbar a").forEach(a => {
    a.classList.toggle("active", a.dataset.tab === r.tab);
  });
}

window.addEventListener("hashchange", route);
route();

// ---------- offline plumbing ----------

const badge = document.getElementById("offline-badge");
const syncBadge = () => { badge.hidden = navigator.onLine; };
window.addEventListener("online", syncBadge);
window.addEventListener("offline", syncBadge);
syncBadge();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* still works online */ });
}
