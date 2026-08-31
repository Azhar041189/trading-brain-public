const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('================================================================');
console.log('  🛡️ TESTING HARDENED TAMPER-EVIDENT PROBATION SENTINEL        ');
console.log('================================================================\n');

const testPath = path.join(__dirname, '../data/test_probation_ledger_hardened.json');
if (fs.existsSync(testPath)) fs.unlinkSync(testPath);

const PaperProbationSentinel = require('../src/core/paperProbationSentinel').constructor;
const sentinel = new PaperProbationSentinel({
  storagePath: testPath,
  targetTradesPerAsset: 10,
  supportedAssets: ['BTCUSDT', 'ETHUSDT', 'NIFTY50']
});

// Test 1: Record Authenticated HMAC Block
const b1 = sentinel.recordTrade({
  tradeId: 'T_001',
  model: 'CANDIDATE_v14_1',
  symbol: 'BTCUSDT',
  direction: 'LONG',
  entryPrice: 60000,
  exitPrice: 60600,
  quantity: 0.002,
  grossPnL: 1.20,
  fees: 0.18,
  netPnL: 1.02,
  regime: 'NORMAL_TREND'
});
assert(b1.signature !== undefined && b1.signature.length === 64, 'Generated authentic HMAC-SHA256 signature');
console.log('✅ [PASS] Block 0 recorded with HMAC-SHA256 signature');

// Test 2: Duplicate Trade ID Rejection
const bDup = sentinel.recordTrade({
  tradeId: 'T_001', // Duplicate
  symbol: 'BTCUSDT',
  netPnL: 5.00
});
assert.strictEqual(bDup, null, 'Rejected duplicate trade ID');
console.log('✅ [PASS] Successfully rejected duplicate trade ID');

// Test 3: NIFTY -> NIFTY50 Standardization
const b3 = sentinel.recordTrade({
  tradeId: 'T_002',
  model: 'CONTROL_v14_0',
  symbol: 'NIFTY', // Unstandardized
  netPnL: 2.50
});
assert.strictEqual(b3.trade.symbol, 'NIFTY50', 'Auto-standardized NIFTY to NIFTY50');
console.log('✅ [PASS] Symbol naming standardized to NIFTY50');

// Test 4: Startup Full-Chain Verification on Valid Ledger
const verifierSentinel = new PaperProbationSentinel({
  storagePath: testPath,
  targetTradesPerAsset: 10,
  supportedAssets: ['BTCUSDT', 'ETHUSDT', 'NIFTY50']
});
assert.strictEqual(verifierSentinel.trades.length, 2, 'Verified 2 blocks successfully on startup');
console.log('✅ [PASS] Startup full-chain verification passed on authentic ledger');

// Test 5: Tamper Detection (Simulate manual file alteration)
const raw = JSON.parse(fs.readFileSync(testPath, 'utf8'));
raw[0].trade.netPnL = 9999.00; // Tamper with profit
fs.writeFileSync(testPath, JSON.stringify(raw), 'utf8');

const tamperedSentinel = new PaperProbationSentinel({
  storagePath: testPath,
  targetTradesPerAsset: 10,
  supportedAssets: ['BTCUSDT', 'ETHUSDT', 'NIFTY50']
});
assert.strictEqual(tamperedSentinel.trades.length, 0, 'Tampered ledger rejected completely on startup');
console.log('✅ [PASS] Tamper detection successfully trapped altered payload');

// Cleanup
if (fs.existsSync(testPath)) fs.unlinkSync(testPath);

console.log('\n================================================================');
console.log('🎉 HARDENED TAMPER-EVIDENT SENTINEL TESTS PASSED (100% GREEN)!');
console.log('================================================================');
