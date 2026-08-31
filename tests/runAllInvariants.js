#!/usr/bin/env node
/**
 * tests/runAllInvariants.js
 *
 * Runs the comprehensive mathematical, risk, and structural invariant test suite.
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function runBattery() {
  console.log('🧪 Starting Invariant Property & Integration Verification Battery...\n');

  // Boot local demo server for integration tests
  let serverProcess = null;
  try {
    process.env.TRADING_BRAIN_MODE = 'DEMO';
    process.env.PORT = '3004';
    serverProcess = spawn('node', [path.resolve(__dirname, '../src/dashboard/server.js')], {
      env: { ...process.env, TRADING_BRAIN_MODE: 'DEMO', PORT: '3004' },
      stdio: 'ignore'
    });
    // Wait for server to boot
    await new Promise(r => setTimeout(r, 2000));
  } catch (e) {}

  const testFiles = fs.readdirSync(__dirname).filter(f => f.startsWith('test_') && f.endsWith('.js'));
  let passed = 0;
  let failed = 0;

  for (const file of testFiles) {
    const filePath = path.join(__dirname, file);
    try {
      process.stdout.write(`  ▶ Running ${file}... `);
      execSync(`node "${filePath}"`, { 
        stdio: 'pipe',
        env: { ...process.env, TRADING_BRAIN_MODE: 'DEMO', PORT: '3004' }
      });
      console.log('✅ PASS');
      passed++;
    } catch (err) {
      console.log('❌ FAIL');
      console.error(`    Error output: ${err.stderr ? err.stderr.toString() : err.message}`);
      failed++;
    }
  }

  if (serverProcess) {
    try { serverProcess.kill(); } catch (e) {}
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 Invariant Test Results: ${passed} Passed | ${failed} Failed`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎯 100% Invariant Verification PASS (G-07 Complete)');
    process.exit(0);
  }
}

runBattery().catch(e => { console.error(e); process.exit(1); });
