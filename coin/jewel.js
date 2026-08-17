/**
 * TimeCoin jewels — every mined block is a one-of-a-kind gem.
 * ===========================================================
 *
 * Jewellery is desired for reasons money isn't: it is beautiful, rare in
 * grades, carries provenance, and can be engraved. A proof-of-work block
 * already has all four, sitting unused in data the consensus verifies:
 *
 *   • BEAUTY      — the block hash seeds a deterministic generative gem:
 *                   same hash, same jewel, on every device, forever.
 *   • RARITY      — a valid hash must beat the difficulty target, but by
 *                   luck it can beat it by extra leading zero bits. Those
 *                   extra bits are genuinely scarce (each one halves the
 *                   odds), verifiable by anyone, and impossible to forge
 *                   without redoing the work: a natural cut grade.
 *   • PROVENANCE  — height, timestamp and halving era are the hallmark:
 *                   which block, when, in which vintage. Era-one jewels
 *                   can never be minted again.
 *   • ENGRAVING   — the coinbase `extra` field is sealed under the block
 *                   hash by the proof-of-work itself. An inscription can
 *                   never be edited, only re-mined.
 *
 * Pure and dependency-free like engine.js: no DOM, no clock, no randomness —
 * everything derives from chain data, so it's unit-testable and identical on
 * every node. UMD-loaded the same way (`self.BallrzJewel` / module.exports).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BallrzJewel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Leading zero bits of a 64-char hex string (a 256-bit number).
  function zeroBits(hex) {
    var bits = 0;
    for (var i = 0; i < hex.length; i++) {
      var v = parseInt(hex[i], 16);
      if (v === 0) { bits += 4; continue; }
      bits += v < 2 ? 3 : v < 4 ? 2 : v < 8 ? 1 : 0;
      break;
    }
    return bits;
  }

  // How many leading zero bits the hash has BEYOND what the target demanded.
  // Every extra bit halves the odds — grade 4 is a 1-in-16 find.
  function extraBits(hash, target) {
    return Math.max(0, zeroBits(hash) - zeroBits(target));
  }

  var GRADES = [
    { min: 0, tier: 0, name: 'Polished', icon: '💠' },
    { min: 2, tier: 1, name: 'Fine', icon: '✨' },
    { min: 4, tier: 2, name: 'Flawless', icon: '💎' },
    { min: 6, tier: 3, name: 'Legendary', icon: '🌟' }
  ];
  function gradeOf(extra) {
    var g = GRADES[0];
    for (var i = 0; i < GRADES.length; i++) if (extra >= GRADES[i].min) g = GRADES[i];
    return { tier: g.tier, name: g.name, icon: g.icon, extraBits: extra };
  }

  var ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  function eraOf(height, halvingInterval) {
    var n = Math.floor(height / halvingInterval) + 1;
    return { n: n, label: 'Era ' + (ROMAN[n - 1] || n) };
  }

  function byteAt(hash, i) { return parseInt(hash.substr((i * 2) % 62, 2), 16); }

  // Deterministic visual recipe from the hash: hue, a companion hue, facet
  // count and cut proportions. Skips the leading zeros (they're all alike) by
  // reading from the tail half of the hash, where the entropy lives.
  function gemSpec(hash) {
    var t = hash.slice(32); // tail 128 bits — never part of the zero prefix
    var b = function (i) { return byteAt(t, i); };
    return {
      hue: (b(0) * 256 + b(1)) % 360,
      hue2: ((b(0) * 256 + b(1)) % 360 + 40 + b(2) % 80) % 360,
      facets: 5 + (b(3) % 5),            // 5–9 outer facets
      squash: 0.82 + (b(4) % 32) / 200,  // 0.82–0.98 width/height ratio
      tilt: (b(5) % 36) - 18             // −18°…+17° rotation
    };
  }

  // Inline SVG of the gem — a faceted brilliant cut drawn from the spec.
  // Higher grades earn a halo (tier 2) and rays (tier 3). Size in px.
  function gemSVG(hash, target, size) {
    var spec = gemSpec(hash);
    var grade = gradeOf(extraBits(hash, target));
    var s = size || 56, c = s / 2, R = s * 0.42;
    var pts = [], i, a;
    for (i = 0; i < spec.facets; i++) {
      a = (Math.PI * 2 * i) / spec.facets - Math.PI / 2;
      pts.push([c + Math.cos(a) * R * spec.squash, c + Math.sin(a) * R]);
    }
    var ring = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var h1 = spec.hue, h2 = spec.hue2;
    var facetTris = '';
    for (i = 0; i < spec.facets; i++) {
      var p1 = pts[i], p2 = pts[(i + 1) % spec.facets];
      var light = 38 + ((i * 7) % 4) * 9; // alternating facet lightness
      facetTris += '<polygon points="' + c + ',' + c + ' ' + p1[0].toFixed(1) + ',' + p1[1].toFixed(1) +
        ' ' + p2[0].toFixed(1) + ',' + p2[1].toFixed(1) + '" fill="hsl(' + (i % 2 ? h2 : h1) + ',72%,' + light + '%)"/>';
    }
    var extras = '';
    if (grade.tier >= 2) extras += '<circle cx="' + c + '" cy="' + c + '" r="' + (R + s * 0.05).toFixed(1) +
      '" fill="none" stroke="hsl(' + h1 + ',85%,70%)" stroke-opacity="0.55" stroke-width="' + (s * 0.02).toFixed(1) + '"/>';
    if (grade.tier >= 3) {
      for (i = 0; i < 8; i++) {
        a = (Math.PI * 2 * i) / 8 + (spec.tilt * Math.PI) / 180;
        extras += '<line x1="' + (c + Math.cos(a) * (R + s * 0.07)).toFixed(1) + '" y1="' + (c + Math.sin(a) * (R + s * 0.07)).toFixed(1) +
          '" x2="' + (c + Math.cos(a) * (R + s * 0.16)).toFixed(1) + '" y2="' + (c + Math.sin(a) * (R + s * 0.16)).toFixed(1) +
          '" stroke="hsl(' + h2 + ',90%,75%)" stroke-width="' + (s * 0.02).toFixed(1) + '" stroke-linecap="round"/>';
      }
    }
    // a small table (the flat top facet) + a sparkle highlight
    var table = '<circle cx="' + c + '" cy="' + c + '" r="' + (R * 0.34).toFixed(1) + '" fill="hsl(' + h1 + ',60%,72%)" fill-opacity="0.9"/>';
    var sparkle = '<circle cx="' + (c - R * 0.28).toFixed(1) + '" cy="' + (c - R * 0.34).toFixed(1) + '" r="' + (s * 0.035).toFixed(1) + '" fill="#fff" fill-opacity="0.85"/>';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s + '" viewBox="0 0 ' + s + ' ' + s +
      '" role="img" aria-label="' + grade.name + ' jewel"><g transform="rotate(' + spec.tilt + ' ' + c + ' ' + c + ')">' +
      facetTris + '<polygon points="' + ring + '" fill="none" stroke="hsl(' + h1 + ',50%,20%)" stroke-width="1"/>' +
      table + sparkle + extras + '</g></svg>';
  }

  // Walk a chain's blocks and collect the jewels belonging to `addresses`
  // (a Set or array of payout addresses): every block whose coinbase paid one
  // of them, with its grade, era, engraving and provenance.
  function jewelsOf(blocks, addresses, halvingInterval) {
    var mine = {};
    if (addresses && typeof addresses.forEach === 'function') {
      addresses.forEach(function (a) { mine[a] = true; }); // Set or Array
    } else if (addresses) {
      for (var k in addresses) if (addresses[k]) mine[k] = true; // plain {addr: true} map
    }
    var out = [];
    for (var i = 1; i < blocks.length; i++) { // genesis pays nobody
      var b = blocks[i], cb = b.transactions && b.transactions[0];
      if (!cb || cb.type !== 'coinbase' || !cb.outputs || !cb.outputs.length) continue;
      if (!mine[cb.outputs[0].address]) continue;
      var extra = extraBits(b.hash, b.target);
      out.push({
        height: b.height,
        hash: b.hash,
        target: b.target,
        timestamp: b.timestamp,
        address: cb.outputs[0].address,
        amount: cb.outputs.reduce(function (a, o) { return a + o.amount; }, 0),
        engraving: cb.extra || '',
        grade: gradeOf(extra),
        era: eraOf(b.height, halvingInterval)
      });
    }
    return out.reverse(); // newest first — the front of the display case
  }

  return {
    zeroBits: zeroBits, extraBits: extraBits, gradeOf: gradeOf, eraOf: eraOf,
    gemSpec: gemSpec, gemSVG: gemSVG, jewelsOf: jewelsOf, GRADES: GRADES
  };
});
