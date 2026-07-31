import test from "node:test";
import assert from "node:assert/strict";
import { GUIDES, EMERGENCY_NUMBERS, CHECKLISTS, DISCLAIMER } from "../data.js";

test("guides: ids are unique and url-safe", () => {
  const ids = GUIDES.map(g => g.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate guide id");
  for (const id of ids) assert.match(id, /^[\w-]+$/, `id "${id}" would break the #/guide/ route`);
});

test("guides: every guide is complete and readable", () => {
  assert.ok(GUIDES.length >= 12, "expected a substantial guide library");
  for (const g of GUIDES) {
    assert.ok(g.title && g.title.length >= 3, `${g.id}: missing title`);
    assert.ok(g.icon, `${g.id}: missing icon`);
    assert.ok(g.summary && g.summary.length >= 10, `${g.id}: missing summary`);
    assert.equal(typeof g.urgent, "boolean", `${g.id}: urgent must be boolean`);
    assert.equal(typeof g.callFirst, "boolean", `${g.id}: callFirst must be boolean`);
    assert.ok(Array.isArray(g.steps) && g.steps.length >= 5, `${g.id}: needs at least 5 steps`);
    for (const s of g.steps) {
      assert.equal(typeof s, "string");
      assert.ok(s.trim().length >= 15, `${g.id}: step too short to be actionable: "${s}"`);
    }
  }
});

test("guides: life-threatening scenarios tell you to call first", () => {
  for (const id of ["cpr-adult", "heart-attack", "stroke", "anaphylaxis", "severe-bleeding", "drowning", "poisoning"]) {
    const g = GUIDES.find(x => x.id === id);
    assert.ok(g, `missing critical guide ${id}`);
    assert.equal(g.callFirst, true, `${id} must set callFirst`);
    assert.equal(g.urgent, true, `${id} must be marked urgent`);
  }
});

test("emergency numbers: every entry has dialable data", () => {
  assert.ok(EMERGENCY_NUMBERS.length >= 30, "expected broad country coverage");
  const regions = EMERGENCY_NUMBERS.map(e => e.region);
  assert.equal(new Set(regions).size, regions.length, "duplicate region");
  for (const e of EMERGENCY_NUMBERS) {
    assert.ok(e.region, "entry missing region name");
    assert.ok(Array.isArray(e.codes) && e.codes.length >= 1, `${e.region}: missing codes`);
    if (e.all) {
      assert.equal(typeof e.all, "string");
      assert.ok(e.all.trim().length > 0);
    } else {
      for (const svc of ["police", "ambulance", "fire"]) {
        assert.ok(e[svc], `${e.region}: missing ${svc} number`);
        assert.match(e[svc], /^\d{2,6}$/, `${e.region}: ${svc} "${e[svc]}" is not a plain dial code`);
      }
    }
  }
});

test("emergency numbers: key regions are covered", () => {
  const blob = EMERGENCY_NUMBERS.map(e => e.region).join("|");
  for (const must of ["European Union", "United States", "United Kingdom", "India", "China", "Brazil", "Nigeria", "Indonesia", "Japan", "Australia"]) {
    assert.ok(blob.includes(must), `missing region: ${must}`);
  }
});

test("checklists: complete, unique, and non-trivial", () => {
  const ids = CHECKLISTS.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate checklist id");
  for (const cl of CHECKLISTS) {
    assert.ok(cl.title && cl.blurb && cl.icon, `${cl.id}: incomplete header`);
    assert.ok(cl.items.length >= 10, `${cl.id}: a preparedness list this short is false confidence`);
    const items = new Set(cl.items);
    assert.equal(items.size, cl.items.length, `${cl.id}: duplicate items`);
  }
});

test("disclaimer exists and says what it must", () => {
  assert.ok(DISCLAIMER.length > 50);
  assert.match(DISCLAIMER, /not medical advice/i);
  assert.match(DISCLAIMER, /emergency number/i);
});
