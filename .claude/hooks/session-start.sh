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
# cached after the hook, so a plain install is fine). The ApexVIP backend
# (functions) and frontend (apexvip-web) are TypeScript and need their toolchains
# installed so the typecheck below can run.
for dir in . concepts/prototypes/concierge-split functions apexvip-web; do
  if [ -f "$dir/package.json" ]; then
    ( cd "$dir" && npm install --no-audit --no-fund --loglevel=error ) || \
      echo "⚠️  npm install failed in $dir (continuing)"
  fi
done

# Typecheck the TypeScript packages so a broken contract / type error surfaces at
# session start, not at deploy. Don't fail the hook on red — just surface it.
for dir in functions apexvip-web; do
  if [ -f "$dir/package.json" ]; then
    echo "── typecheck: $dir ──"
    ( cd "$dir" && npm run --silent typecheck ) || echo "⚠️  typecheck failed in $dir (see above)"
  fi
done

# Run the typed concierge engine tests (the migrated ApexAI brain).
echo "── apexvip-web tests ──"
( cd apexvip-web && npm test --silent ) || echo "⚠️  apexvip-web tests reported failures (see above)"

# Smoke-test the prototypes. Don't fail the hook on a red test — just surface it,
# so the session still starts and the agent can see/fix the breakage.
echo "── prototype smoke test ──"
node scripts/smoke-prototypes.mjs || echo "⚠️  prototype smoke test reported failures (see above)"
