/**
 * Helix Bridge — the glue that drops the Helix engine into each app.
 *
 * Every app in this repo already persists to localStorage and makes some
 * "pick from a set" decision. Rather than re-wire snapshot/restore in each one,
 * the bridge gives you a NAMED, auto-persisted Helix instance in one call:
 *
 *     var e = HelixBridge.engine('apex-vehicle', { decay: 0.97 });
 *     e.arm('sClass').arm('vClass');
 *     var pick = e.best();              // choose
 *     HelixBridge.reward('apex-vehicle', pick, 1); // learn + auto-save
 *
 * State is stored under localStorage key  "helix.<name>"  as a Helix snapshot,
 * so learning survives reloads. Everything is defensive: if Helix isn't loaded,
 * localStorage is unavailable (private mode / Node), or a stored snapshot is
 * corrupt, the bridge degrades gracefully instead of throwing into the app.
 *
 * UMD — window.HelixBridge in the browser, require()/vm in Node. Unit-tested in
 * scripts/test-helix-bridge.mjs.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    var H = (typeof require === 'function') ? require('./helix.js') : (root && root.Helix);
    module.exports = factory(H);
  } else {
    root.HelixBridge = factory(root.Helix);
  }
})(typeof self !== 'undefined' ? self : this, function (Helix) {
  'use strict';

  var registry = {}; // name -> live engine (one per name per page)

  function store() {
    try { return (typeof localStorage !== 'undefined') ? localStorage : null; }
    catch (e) { return null; } // some browsers throw on access in private mode
  }
  function key(name) { return 'helix.' + name; }

  // Get-or-create a named engine. On first touch it restores any saved snapshot,
  // so callers never deal with persistence directly. Returns null (never throws)
  // if Helix isn't available, so app code can `if (e) …` and otherwise no-op.
  function engine(name, opts) {
    if (registry[name]) return registry[name];
    if (typeof Helix !== 'function') return null;
    var e = Helix(merge({ seed: name }, opts));
    var s = store();
    if (s) {
      try {
        var raw = s.getItem(key(name));
        if (raw) e.restore(JSON.parse(raw)); // resume learning across reloads
      } catch (err) { /* corrupt/old snapshot — keep the fresh engine */ }
    }
    registry[name] = e;
    return e;
  }

  // Save a named engine's state. Safe no-op without localStorage.
  function persist(name) {
    var e = registry[name], s = store();
    if (!e || !s) return false;
    try { s.setItem(key(name), JSON.stringify(e.snapshot())); return true; }
    catch (err) { return false; } // quota / serialization failure — don't break the app
  }

  // The common path: record an outcome and immediately persist. Auto-creates the
  // engine and the arm if needed so a single call is enough at a feedback site.
  function reward(name, id, value, opts) {
    var e = engine(name, opts);
    if (!e) return false;
    try { e.arm(id).reward(id, value); persist(name); return true; }
    catch (err) { return false; }
  }

  // Forget everything for a name (engine + stored snapshot). Handy for "reset".
  function reset(name) {
    delete registry[name];
    var s = store();
    if (s) { try { s.removeItem(key(name)); } catch (e) {} }
  }

  function merge(a, b) {
    var o = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
    if (b) for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
    return o;
  }

  return {
    engine: engine,
    persist: persist,
    reward: reward,
    reset: reset,
    available: function () { return typeof Helix === 'function'; },
    _registry: registry, // exposed for tests
  };
});
