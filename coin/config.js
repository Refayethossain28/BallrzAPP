/**
 * TimeCoin network config.
 *
 * Leave relayUrl empty and the coin is local-only: tabs in the same browser
 * still sync over BroadcastChannel. To connect nodes across DIFFERENT devices
 * (your phone + your laptop + a friend's browser), run the relay somewhere:
 *
 *     node coin/server.mjs                    # local test  → 'http://localhost:8087'
 *     # or deploy server.mjs to Render/Railway/any Node host → 'https://your-relay.example.com'
 *
 * and put its URL here. Note: a page served over https:// (like GitHub Pages)
 * can only call an https:// relay.
 */
(typeof self !== 'undefined' ? self : this).BALLRZCOIN_CONFIG = {
  relayUrl: '',
  // The World Commons: a well-known meeting relay every circle can join for
  // worldwide discovery (social layer only — it can never touch coin chains).
  // Deploy a second relay instance and put its URL here so every copy of the
  // app offers one-tap "🌍 Join the commons". See WORLD.md.
  commonsUrl: ''
};
