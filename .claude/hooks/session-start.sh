#!/bin/bash
# SessionStart hook for Claude Code on the web.
# Prepares the repo so tests run, then smoke-tests the single-file prototypes
# so undefined-reference bugs (the kind that render a blank screen) surface at
# session start instead of in someone's browser.
set -euo pipefail

# Only needed in the remote/web sandbox; local machines are already set up.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install Node deps for any package that has them (idempotent; container state is
# cached after the hook, so a plain install is fine). No-op today since the
# prototypes are dependency-free, but future-proofs the hook.
for dir in . concepts/prototypes/concierge-split; do
  if [ -f "$dir/package.json" ]; then
    ( cd "$dir" && npm install --no-audit --no-fund --loglevel=error ) || \
      echo "⚠️  npm install failed in $dir (continuing)"
  fi
done

# Smoke-test the prototypes. Don't fail the hook on a red test — just surface it,
# so the session still starts and the agent can see/fix the breakage.
echo "── prototype smoke test ──"
node scripts/smoke-prototypes.mjs || echo "⚠️  prototype smoke test reported failures (see above)"
