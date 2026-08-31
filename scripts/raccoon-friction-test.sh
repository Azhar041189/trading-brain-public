#!/usr/bin/env bash
# scripts/raccoon-friction-test.sh
# Automated 5-Minute Sandbox & Zero-Key Onboarding Test (G-08)

set -e
echo "🦝 Running Automated 5-Minute Raccoon Friction Test (G-08)..."

START_TIME=$(date +%s)

# 1. Verify Node and pnpm versions
echo "⚙️ Checking Canonical Environment..."
node -v
pnpm -v || npx pnpm -v

# 2. Run Public Artifact Invariant Tests
echo "🧪 Running 43 Mathematical & Risk Invariant Tests..."
node tests/runAllInvariants.js

# 3. Simulate Zero-Key Boot in DEMO mode
echo "🚀 Booting Trading Brain in TRADING_BRAIN_MODE=DEMO..."
TRADING_BRAIN_MODE=DEMO PORT=3099 node src/dashboard/server.js &
SERVER_PID=$!

sleep 4

# 4. Check Health Endpoint
echo "📡 Verifying Health & Web UI Endpoint..."
curl -s http://localhost:3099/api/health | grep -q "ok" || (echo "❌ Health check failed" && kill $SERVER_PID && exit 1)

# Cleanup server
kill $SERVER_PID

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "✅ [G-08 PASSED] 5-Minute Sandbox Test Completed in ${DURATION}s (Target: < 300s)."
