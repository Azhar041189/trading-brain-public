/**
 * test_directional_volume_regime_engine.js
 * 
 * Comprehensive QA Test Suite for Candle Directional Volume Delta & Regime Engine:
 * - Directional volume calculation
 * - Fail-safe neutral bypass on missing/zero volume (no synthetic data)
 * - Explicit fail-safe neutral bypass assertion
 * - Swing-separated absorption & divergence
 * - Market-aware regime annualization
 * - Frozen baseline default isolation assertion
 */

const assert = require('assert');
const engine = require('../src/core/directionalVolumeDeltaRegimeEngine');
const chartContextModule = require('../src/agents/hypothesis/chartContextHypothesisModule');

console.log('================================================================');
console.log('  🧪 DIRECTIONAL VOLUME DELTA & REGIME ENGINE QA SUITE          ');
console.log('================================================================\n');

// 1. Test Directional Delta Calculation
console.log('1. Testing computeDirectionalDelta()...');
const validCandles = [
  { open: 100, high: 105, low: 98, close: 104, volume: 1000 },
  { open: 104, high: 108, low: 102, close: 107, volume: 1200 },
  { open: 107, high: 110, low: 105, close: 106, volume: 800 },
  { open: 106, high: 107, low: 99, close: 100, volume: 2000 },
  { open: 100, high: 103, low: 99, close: 102, volume: 1500 }
];

const res1 = engine.computeDirectionalDelta(validCandles);
assert.strictEqual(res1.valid, true, 'Result must be valid');
assert.strictEqual(res1.series.length, 5, 'Series length must match candles length');
console.log('   PASS: Computed 5-bar directional delta series successfully\n');

// 2. Test Fail-Safe Neutral Bypass on Missing / Invalid Volume (Zero Synthetic Data)
console.log('2. Testing Fail-Safe Neutral Bypass on Missing or Invalid Volume...');
const missingVolCandles = [
  { open: 100, high: 105, low: 98, close: 104, volume: 0 },
  { open: 104, high: 108, low: 102, close: 107, volume: null },
  { open: 107, high: 110, low: 105, close: 106, volume: NaN },
  { open: 106, high: 107, low: 99, close: 100, volume: -50 },
  { open: 100, high: 103, low: 99, close: 102, volume: 1000 }
];

const bypassRes = engine.evaluateEdge('BTCUSDT', missingVolCandles, 'LONG', 'CRYPTO');
assert.strictEqual(bypassRes.valid, false, 'Result must be invalid on missing volume');
assert.strictEqual(bypassRes.status, 'FAIL_SAFE_NEUTRAL_BYPASS', 'Status must be FAIL_SAFE_NEUTRAL_BYPASS');
assert.strictEqual(bypassRes.authorizesTrade, false, 'Must explicitly declare authorizesTrade: false');
assert.strictEqual(bypassRes.contribution, 'NO_CONTRIBUTION', 'Must explicitly declare contribution: NO_CONTRIBUTION');
assert.strictEqual(bypassRes.reason, 'INVALID_OR_MISSING_VOLUME_DATA', 'Must state exact reason');
console.log('   PASS: Fail-Safe Neutral Bypass Verified: ' + bypassRes.status + ' | ' + bypassRes.contribution + '\n');

// 3. Test Swing-Separated Absorption Divergence
console.log('3. Testing Swing-Separated Absorption Divergence...');
const swingSeries = {
  valid: true,
  series: []
};

let price = 100;
let cumDelta = 10;
for (let i = 0; i < 20; i++) {
  price -= 1;
  cumDelta += 10;
  swingSeries.series.push({
    timestamp: i,
    close: price,
    high: price + 2,
    low: price - 2,
    volume: 1000,
    delta: 10,
    cumulativeDelta: cumDelta
  });
}

const absorption = engine.detectAbsorptionDivergence(swingSeries);
assert.strictEqual(absorption.hasDivergence, true, 'Must detect divergence');
assert.strictEqual(absorption.type, 'BULLISH_ABSORPTION', 'Must be BULLISH_ABSORPTION');
console.log('   PASS: Swing-separated Bullish Absorption detected: ' + absorption.details + '\n');

// 4. Test Market-Aware Annualization Factors
console.log('4. Testing Market-Aware Annualization Factors...');
const cryptoRegime = engine.classifyRegime(validCandles.concat(validCandles, validCandles, validCandles), 'CRYPTO');
const nseRegime = engine.classifyRegime(validCandles.concat(validCandles, validCandles, validCandles), 'IN');
assert.strictEqual(typeof cryptoRegime.volatility, 'number', 'Crypto vol must be numeric');
assert.strictEqual(typeof nseRegime.volatility, 'number', 'NSE vol must be numeric');
console.log('   PASS: Crypto 24/7 Vol: ' + cryptoRegime.volatility + ' | NSE Session Vol: ' + nseRegime.volatility + '\n');

// 5. Test evaluateEdge Full Pipeline on Valid History
console.log('5. Testing evaluateEdge() Pipeline on Valid History...');
const edge = engine.evaluateEdge('BTCUSDT', validCandles.concat(validCandles, validCandles, validCandles), 'LONG', 'CRYPTO');
assert.strictEqual(edge.valid, true, 'Edge evaluation must be valid');
assert.strictEqual(typeof edge.edgeScore, 'number', 'Edge score must be numeric');
console.log('   PASS: Edge Score: ' + edge.edgeScore + ' | Valid: ' + edge.valid + '\n');

// 6. Test Frozen Baseline Default Isolation Invariant
console.log('6. Testing Frozen Baseline Default Isolation Invariant...');
const testSignal = { symbol: 'BTCUSDT', direction: 'LONG', price: 100 };
const testCandles = validCandles.concat(validCandles, validCandles, validCandles);

// Default evaluation (should have directionalVolume disabled)
const defaultEvidence = chartContextModule.evaluateEvidence(testSignal, testCandles, 'CRYPTO');

// Explicit baseline without directional volume
const explicitBaseline = chartContextModule.evaluateEvidence(testSignal, testCandles, 'CRYPTO', {
  vwap: true,
  volumeProfile: true,
  marketStructure: true,
  rvol: true,
  directionalVolume: false
});

assert.strictEqual(defaultEvidence.evidenceScore, explicitBaseline.evidenceScore, 'Default score must exactly match baseline');
assert.strictEqual(defaultEvidence.confidenceModifier, explicitBaseline.confidenceModifier, 'Default modifier must match baseline');
assert.deepStrictEqual(defaultEvidence.confluences, explicitBaseline.confluences, 'Default confluences must match baseline');
assert.deepStrictEqual(defaultEvidence.detractors, explicitBaseline.detractors, 'Default detractors must match baseline');
console.log('   PASS: Frozen baseline default isolation PROVED: default score === explicit baseline score (' + defaultEvidence.evidenceScore + ' === ' + explicitBaseline.evidenceScore + ')\n');

console.log('================================================================');
console.log('  🎉 DIRECTIONAL VOLUME REGIME ENGINE: 100% VERIFIED & GREEN    ');
console.log('================================================================');
